

// ====================== الإعدادات ======================
const WEB_APP_URL_GET = "https://script.google.com/macros/s/AKfycbxmzqRPHjrvDYrClik3bn7OBI-saQvO8c4RtSZ6AZfeguTbUV57CPNaRE9rOrlpSMQj/exec";
const WEB_APP_URL_POST = "https://script.google.com/macros/s/AKfycbzVwUuZ2YSwBFz9C1OTIG4RhbqgWgjhNZP4JQPimiwtXaFi28rbzzSzdXqSat3BO-9X/exec";

// حدود الصور
const RAW_FILE_MAX_BYTES = 25 * 1024 * 1024; // أقصى حجم ملف خام مقبول قبل الضغط
const IMAGE_TARGET_BYTES = 500 * 1024;       // الحجم المستهدف بعد الضغط (500KB)
const IMAGE_MAX_DIM = 1600;                  // أقصى بُعد (عرض/ارتفاع) بالبكسل
const JPEG_START_QUALITY = 0.82;
const JPEG_MIN_QUALITY = 0.40;

// الشبكة
const POST_TIMEOUT_MS = 90000;
const POST_MAX_ATTEMPTS = 4;      // محاولات الحفظ (كلها بنفس requestId، فلا يحدث تكرار)
const STATUS_TIMEOUT_MS = 20000;  // مهلة سؤال السيرفر "هل اتحفظ؟"
const GET_TIMEOUT_MS = 10000;
const GET_MAX_ATTEMPTS = 3;

// أنواع الصور المدعومة
const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

// ====================== المتغيرات العامة ======================
let entryCount = 0;
let allVolunteers = [];
let allReceiptTypes = [];
let allIntentions = [];
let allCampaigns = [];
let allCenters = [];
let allDonorCodes = [];
let isSubmitting = false;
let pendingCompressions = 0;

// ============================================================
//  أدوات مساعدة
// ============================================================

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
//  ضغط صورة الإيصال  ← الجزء الأهم
// ============================================================

/**
 * تحميل الصورة كـ ImageBitmap (يحترم اتجاه EXIF تلقائيًا)
 * مع fallback لـ Image عند عدم الدعم.
 */
async function loadImageSource(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (err) {
      console.warn("createImageBitmap فشل، سيتم استخدام الطريقة البديلة:", err);
    }
  }

  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("تعذّر قراءة الصورة. لو الصورة من آيفون بصيغة HEIC، غيّر إعداد الكاميرا إلى «الأكثر توافقًا» أو اختر صورة JPG."));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("فشل إنشاء ملف الصورة المضغوطة."))),
        type,
        quality
      );
      return;
    }
    // fallback للمتصفحات القديمة
    try {
      const dataUrl = canvas.toDataURL(type, quality);
      const binary = atob(dataUrl.split(",")[1]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      resolve(new Blob([bytes], { type }));
    } catch (err) {
      reject(err);
    }
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      comma >= 0 ? resolve(result.slice(comma + 1)) : reject(new Error("فشل تحويل الصورة."));
    };
    reader.onerror = () => reject(new Error("تعذّر قراءة الصورة المضغوطة."));
    reader.readAsDataURL(blob);
  });
}

function releaseCanvas(canvas) {
  // مهم لتحرير الذاكرة على iOS
  canvas.width = 0;
  canvas.height = 0;
}

function safeFileName(originalName) {
  const base = String(originalName || "receipt")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^\w\u0600-\u06FF\s-]+/g, "_")
    .trim()
    .slice(0, 60);
  return (base || "receipt") + ".jpg";
}

/**
 * يضغط الصورة: يصغّر الأبعاد ثم يقلّل الجودة تدريجيًا،
 * ولو لسه كبيرة يصغّر الأبعاد أكتر (حتى 4 جولات).
 */
async function compressReceiptImage(file) {
  if (!file) return null;

  if (file.size > RAW_FILE_MAX_BYTES) {
    throw new Error(`حجم الصورة كبير جدًا (${formatBytes(file.size)}). الحد الأقصى ${formatBytes(RAW_FILE_MAX_BYTES)}.`);
  }

  const type = (file.type || "").toLowerCase();
  if (type && !SUPPORTED_IMAGE_TYPES.includes(type)) {
    if (type.includes("heic") || type.includes("heif")) {
      throw new Error("صيغة HEIC غير مدعومة في المتصفح. من إعدادات الكاميرا في الآيفون اختر «الأكثر توافقًا» أو حوّل الصورة إلى JPG.");
    }
    throw new Error("الملف المختار ليس صورة مدعومة. اختر صورة JPG أو PNG.");
  }

  const source = await loadImageSource(file);
  const srcW = source.width || source.naturalWidth;
  const srcH = source.height || source.naturalHeight;

  if (!srcW || !srcH) {
    if (source.close) source.close();
    throw new Error("تعذّر قراءة أبعاد الصورة. جرّب صورة أخرى.");
  }

  let maxDim = IMAGE_MAX_DIM;
  let bestBlob = null;

  try {
    for (let round = 0; round < 4; round++) {
      const scale = Math.min(1, maxDim / srcW, maxDim / srcH);
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) {
        releaseCanvas(canvas);
        throw new Error("متصفحك لا يدعم معالجة الصور. جرّب Chrome أو Safari محدّث.");
      }

      // خلفية بيضاء: تمنع ظهور PNG الشفاف بخلفية سوداء بعد التحويل لـ JPEG
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, w, h);

      let quality = JPEG_START_QUALITY;
      let blob = await canvasToBlob(canvas, "image/jpeg", quality);

      while (blob.size > IMAGE_TARGET_BYTES && quality > JPEG_MIN_QUALITY) {
        quality = Math.max(JPEG_MIN_QUALITY, quality - 0.1);
        blob = await canvasToBlob(canvas, "image/jpeg", quality);
      }

      releaseCanvas(canvas);
      bestBlob = blob;

      if (blob.size <= IMAGE_TARGET_BYTES) break;
      maxDim = Math.round(maxDim * 0.75); // جولة أخرى بأبعاد أصغر
    }
  } finally {
    if (source.close) source.close();
  }

  if (!bestBlob) throw new Error("فشل ضغط صورة الإيصال.");

  if (bestBlob.size > IMAGE_TARGET_BYTES * 1.6) {
    throw new Error(`تعذّر ضغط الصورة لحجم مناسب (${formatBytes(bestBlob.size)}). جرّب تصوير الإيصال من مسافة أقرب أو بإضاءة أفضل.`);
  }

  const base64 = await blobToBase64(bestBlob);

  return {
    base64,
    mimeType: "image/jpeg",
    fileName: safeFileName(file.name),
    size: bestBlob.size,
    originalSize: file.size,
    previewUrl: URL.createObjectURL(bestBlob),
  };
}

// ============================================================
//  تحميل البيانات
// ============================================================

async function fetchData(sheet) {
  const url = `${WEB_APP_URL_GET}?sheet=${encodeURIComponent(sheet)}`;

  for (let attempt = 1; attempt <= GET_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GET_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error(`محاولة ${attempt} فشلت للورقة ${sheet}:`, err);
      if (attempt === GET_MAX_ATTEMPTS) {
        const isAbort = err.name === "AbortError";
        throw new Error(
          isAbort
            ? `انتهت مهلة الاتصال عند تحميل «${sheet}»`
            : `فشل تحميل «${sheet}»: ${err.message || err}`
        );
      }
      await sleep(600 * Math.pow(2, attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

async function loadAllData() {
  const overlay = document.getElementById("loadingOverlay");

  try {
    const [campaigns, centers, receiptTypes, intentions, volunteers, donorCodes] =
      await Promise.all([
        fetchData("Campaigns"),
        fetchData("Centers"),
        fetchData("ReceiptTypes"),
        fetchData("Intentions"),
        fetchData("Volunteers"),
        fetchData("donorCode"),
      ]);

    allCampaigns = campaigns;
    allCenters = centers;
    allReceiptTypes = receiptTypes;
    allIntentions = intentions;
    allVolunteers = volunteers;
    allDonorCodes = donorCodes;

    populateSelect("campaign", allCampaigns);
    populateSelect("center", allCenters);

    refreshAllLists();
    checkCanAddEntry();
    updateSubmitButton();
  } catch (error) {
    console.error("خطأ في تحميل البيانات:", error);
    showError(`${error.message}. تأكد من الاتصال بالإنترنت ثم أعد تحميل الصفحة.`);
  } finally {
    if (overlay) overlay.classList.add("hidden");
  }
}

function optionValueOf(item) {
  if (item == null) return "";
  if (typeof item === "string") return item;
  return item.name || item.donorCode || item.id || "";
}

function populateSelect(selectId, data) {
  const select = document.getElementById(selectId);
  if (!select) return;
  populateSelectForElement(select, data);
}

function populateSelectForElement(select, data) {
  if (!select) return;
  const labelText = select.previousElementSibling ? select.previousElementSibling.textContent : "";

  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = `اختر ${labelText}`.trim();
  select.appendChild(placeholder);

  (data || []).forEach((item) => {
    const value = optionValueOf(item);
    if (!value) return;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

// ============================================================
//  القوائم المرتبطة
// ============================================================

function refreshAllLists() {
  const centerSelect = document.getElementById("center");
  const centerName = centerSelect ? centerSelect.value : "";

  const filtered = centerName
    ? allVolunteers.filter((v) => v.center_name === centerName)
    : allVolunteers;

  document.querySelectorAll(".entry-card").forEach((entry) => {
    const datalist = entry.querySelector(".volunteer-list");
    if (datalist) {
      datalist.innerHTML = "";
      filtered.forEach((v) => {
        const option = document.createElement("option");
        option.value = v.name;
        option.dataset.phone = v.phone || "";
        datalist.appendChild(option);
      });
    }

    fillDonorCodeList(entry.querySelector(".donor-code-list"));
  });
}

function fillDonorCodeList(datalist) {
  if (!datalist) return;
  datalist.innerHTML = "";
  allDonorCodes.forEach((code) => {
    const value = optionValueOf(code);
    if (!value) return;
    const option = document.createElement("option");
    option.value = value;
    datalist.appendChild(option);
  });
}

function clearVolunteerData() {
  document.querySelectorAll(".entry-card").forEach((entry) => {
    const name = entry.querySelector(".volunteer-name");
    const phone = entry.querySelector(".volunteer-phone");
    if (name) name.value = "";
    if (phone) phone.value = "";
  });
}

function checkCanAddEntry() {
  const campaign = document.getElementById("campaign");
  const center = document.getElementById("center");
  const addBtn = document.getElementById("addEntryBtn");
  if (!campaign || !center || !addBtn) return;

  const ready = Boolean(campaign.value && center.value) && !isSubmitting;
  addBtn.disabled = !ready;
  addBtn.title = ready ? "إضافة تبرع جديد" : "يرجى اختيار اسم الحملة والمركز أولاً";
}

// ============================================================
//  بطاقات التبرع
// ============================================================

function isValidOptionValue(inputEl, datalistEl) {
  if (!inputEl || !datalistEl) return false;
  const typed = inputEl.value.trim();
  if (!typed) return false;
  return Array.from(datalistEl.options).some((o) => o.value.trim() === typed);
}

function renumberEntries() {
  document.querySelectorAll(".entry-card").forEach((card, index) => {
    const badge = card.querySelector(".entry-number");
    if (badge) badge.textContent = `تبرع ${index + 1}`;
  });
}

function createEntry() {
  const campaign = document.getElementById("campaign");
  const center = document.getElementById("center");

  if (!campaign || !center || !campaign.value || !center.value) {
    showError("⚠️ يرجى اختيار اسم الحملة والمركز أولاً قبل إضافة تبرع");
    return;
  }

  entryCount++;
  const container = document.getElementById("entriesContainer");
  const today = new Date().toISOString().split("T")[0];
  const volunteerListId = `volunteer-list-${entryCount}`;
  const donorCodeListId = `donor-code-list-${entryCount}`;

  const entryHTML = `
    <div class="entry-card" id="entry-${entryCount}" data-request-id="${uuid()}">
      <div class="entry-card-header">
        <span class="entry-number">تبرع ${entryCount}</span>
        <button type="button" class="btn-remove" aria-label="حذف التبرع">×</button>
      </div>

      <div class="form-row">
        <div class="form-group half">
          <label>اسم المتطوع</label>
          <input type="text" class="volunteer-name" list="${volunteerListId}" placeholder="بحث عن المتطوع" autocomplete="off">
          <datalist class="volunteer-list" id="${volunteerListId}"></datalist>
        </div>
        <div class="form-group half">
          <label>رقم الهاتف</label>
          <input type="tel" class="volunteer-phone" placeholder="010XXXXXXXX" inputmode="numeric" maxlength="11">
        </div>
      </div>

      <div class="form-row">
        <div class="form-group half">
          <label>نوع الوصل</label>
          <select class="receipt-type"></select>
        </div>
        <div class="form-group half">
          <label>النية</label>
          <select class="intention"></select>
        </div>
      </div>

      <div class="form-row">
        <div class="form-group half">
          <label>المبلغ (ج.م)</label>
          <input type="number" class="amount" min="1" step="0.01" inputmode="decimal" placeholder="0">
        </div>
        <div class="form-group half">
          <label>الرقم المرجعي</label>
          <input type="text" class="ref-number" placeholder="REF1234" autocomplete="off">
        </div>
      </div>

      <div class="form-row">
        <div class="form-group half">
          <label>التاريخ</label>
          <input type="date" class="entry-date" value="${today}" max="${today}">
        </div>
        <div class="form-group half">
          <label>كود الحالة</label>
          <input type="text" class="donor-code" list="${donorCodeListId}" placeholder="اختر كود الحالة" autocomplete="off">
          <datalist class="donor-code-list" id="${donorCodeListId}"></datalist>
        </div>
      </div>

      <div class="form-group receipt-upload-group">
        <label>صورة الإيصال</label>
        <label class="receipt-upload-box">
          <input type="file" class="receipt-image" accept="image/jpeg,image/png,image/webp">
          <img class="receipt-preview" alt="" hidden>
          <span class="receipt-upload-icon">📄</span>
          <span class="receipt-upload-text">اختر صورة</span>
          <span class="receipt-meta"></span>
        </label>
      </div>
    </div>
  `;

  container.insertAdjacentHTML("beforeend", entryHTML);
  const entryCard = container.lastElementChild;

  populateSelectForElement(entryCard.querySelector(".receipt-type"), allReceiptTypes);
  populateSelectForElement(entryCard.querySelector(".intention"), allIntentions);
  fillDonorCodeList(entryCard.querySelector(".donor-code-list"));

  entryCard.querySelector(".btn-remove").addEventListener("click", () => removeEntry(entryCard));

  wireVolunteerInput(entryCard);
  wireReceiptInput(entryCard);

  refreshAllLists();
  renumberEntries();
  updateSubmitButton();

  setTimeout(() => entryCard.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
}

function wireVolunteerInput(entryCard) {
  const nameInput = entryCard.querySelector(".volunteer-name");
  const phoneInput = entryCard.querySelector(".volunteer-phone");
  const datalist = entryCard.querySelector(".volunteer-list");

  const update = () => {
    const match = Array.from(datalist.options).find(
      (o) => o.value.trim() === nameInput.value.trim()
    );
    if (match) {
      phoneInput.value = match.dataset.phone || "";
      clearFieldError(nameInput);
    } else if (nameInput.value.trim()) {
      phoneInput.value = "";
    }
  };

  nameInput.addEventListener("input", update);
  nameInput.addEventListener("change", update);
  nameInput.addEventListener("blur", update);

  phoneInput.addEventListener("input", () => {
    phoneInput.value = phoneInput.value.replace(/\D/g, "").slice(0, 11);
    clearFieldError(phoneInput);
  });
}

/**
 * الضغط يحصل فور اختيار الصورة، مش وقت الإرسال.
 * النتيجة بتتخزّن على العنصر نفسه في __receipt.
 */
function wireReceiptInput(entryCard) {
  const fileInput = entryCard.querySelector(".receipt-image");
  const textEl = entryCard.querySelector(".receipt-upload-text");
  const metaEl = entryCard.querySelector(".receipt-meta");
  const previewEl = entryCard.querySelector(".receipt-preview");

  const resetPreview = () => {
    if (fileInput.__receipt && fileInput.__receipt.previewUrl) {
      URL.revokeObjectURL(fileInput.__receipt.previewUrl);
    }
    fileInput.__receipt = null;
    previewEl.hidden = true;
    previewEl.removeAttribute("src");
    metaEl.textContent = "";
  };

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    resetPreview();

    if (!file) {
      textEl.textContent = "اختر صورة";
      updateSubmitButton();
      return;
    }

    clearFieldError(fileInput);
    entryCard.classList.add("is-compressing");
    textEl.textContent = "جاري ضغط الصورة...";
    metaEl.textContent = formatBytes(file.size);
    pendingCompressions++;
    updateSubmitButton();

    try {
      const result = await compressReceiptImage(file);
      fileInput.__receipt = result;
      textEl.textContent = result.fileName;
      metaEl.textContent = `${formatBytes(result.originalSize)} ← ${formatBytes(result.size)}`;
      previewEl.src = result.previewUrl;
      previewEl.hidden = false;
    } catch (error) {
      console.error("خطأ في ضغط صورة الإيصال:", error);
      fileInput.value = "";
      textEl.textContent = "اختر صورة";
      metaEl.textContent = "";
      markFieldError(fileInput);
      showNotification("error", error.message || "تعذّر تجهيز صورة الإيصال.", 7000);
    } finally {
      pendingCompressions = Math.max(0, pendingCompressions - 1);
      entryCard.classList.remove("is-compressing");
      updateSubmitButton();
    }
  });
}

function removeEntry(entryCard) {
  if (isSubmitting) return;
  const fileInput = entryCard.querySelector(".receipt-image");
  if (fileInput && fileInput.__receipt && fileInput.__receipt.previewUrl) {
    URL.revokeObjectURL(fileInput.__receipt.previewUrl);
  }
  entryCard.remove();
  renumberEntries();
  updateSubmitButton();
}

function updateSubmitButton() {
  const cards = document.querySelectorAll(".entry-card:not(.is-saved)");
  const btn = document.getElementById("submitBtn");
  if (!btn) return;
  const text = btn.querySelector(".btn-text");

  if (isSubmitting) return;

  if (pendingCompressions > 0) {
    text.textContent = "جاري تجهيز الصور...";
    btn.disabled = true;
    return;
  }

  if (cards.length === 0) {
    text.textContent = "لا توجد تبرعات";
    btn.disabled = true;
  } else {
    text.textContent = `تسجيل الكل (${cards.length})`;
    btn.disabled = false;
  }
}

// ============================================================
//  التحقق
// ============================================================

function markFieldError(field) {
  if (field) field.classList.add("field-error");
}
function clearFieldError(field) {
  if (field) field.classList.remove("field-error");
}

const EGYPT_PHONE_RE = /^0?\d{10}$/;

function validateEntry(entryCard, seenRefs) {
  const errors = [];
  const q = (sel) => entryCard.querySelector(sel);

  const name = q(".volunteer-name");
  const phone = q(".volunteer-phone");
  const receiptType = q(".receipt-type");
  const intention = q(".intention");
  const amount = q(".amount");
  const ref = q(".ref-number");
  const date = q(".entry-date");
  const donorCode = q(".donor-code");
  const fileInput = q(".receipt-image");

  [name, phone, receiptType, intention, amount, ref, date, donorCode, fileInput]
    .forEach(clearFieldError);

  if (!isValidOptionValue(name, entryCard.querySelector(".volunteer-list"))) {
    markFieldError(name);
    errors.push("اسم المتطوع يجب اختياره من القائمة");
  }

  if (!EGYPT_PHONE_RE.test(phone.value.trim())) {
    markFieldError(phone);
    errors.push("رقم الهاتف غير صحيح (10 أو 11 رقم، ويمكن أن يبدأ بصفر أو بدون صفر)");
  }

  if (!receiptType.value) { markFieldError(receiptType); errors.push("اختر نوع الوصل"); }
  if (!intention.value) { markFieldError(intention); errors.push("اختر النية"); }

  const amountValue = Number(amount.value);
  if (!amount.value || !isFinite(amountValue) || amountValue <= 0) {
    markFieldError(amount);
    errors.push("المبلغ يجب أن يكون رقمًا أكبر من صفر");
  }

  const refValue = ref.value.trim();
  if (!refValue) {
    markFieldError(ref);
    errors.push("الرقم المرجعي مطلوب");
  } else if (seenRefs.has(refValue.toLowerCase())) {
    markFieldError(ref);
    errors.push(`الرقم المرجعي «${refValue}» مكرر`);
  } else {
    seenRefs.add(refValue.toLowerCase());
  }

  if (!date.value) {
    markFieldError(date);
    errors.push("التاريخ مطلوب");
  } else if (date.value > new Date().toISOString().split("T")[0]) {
    markFieldError(date);
    errors.push("التاريخ لا يمكن أن يكون في المستقبل");
  }

  if (donorCode.value.trim() &&
      !isValidOptionValue(donorCode, entryCard.querySelector(".donor-code-list"))) {
    markFieldError(donorCode);
    errors.push("كود الحالة يجب اختياره من القائمة");
  }

  if (!fileInput.__receipt) {
    markFieldError(fileInput);
    errors.push(
      fileInput.files && fileInput.files[0]
        ? "صورة الإيصال لم يكتمل تجهيزها، أعد اختيارها"
        : "صورة الإيصال مطلوبة"
    );
  }

  return errors;
}

function entryToPayload(entryCard) {
  const q = (sel) => entryCard.querySelector(sel);
  const receipt = q(".receipt-image").__receipt;

  return {
    requestId: entryCard.dataset.requestId,
    volunteerName: q(".volunteer-name").value.trim(),
    volunteerPhone: q(".volunteer-phone").value.trim(),
    receiptType: q(".receipt-type").value,
    intention: q(".intention").value,
    amount: Number(q(".amount").value),
    refNumber: q(".ref-number").value.trim(),
    date: q(".entry-date").value,
    donorCode: q(".donor-code").value.trim(),
    receiptImageBase64: receipt ? receipt.base64 : null,
    receiptImageName: receipt ? receipt.fileName : "",
    receiptImageType: receipt ? receipt.mimeType : "",
  };
}

// ============================================================
//  الإرسال (تبرع تبرع، مع تتبّع المحفوظ)
// ============================================================

class SaveError extends Error {
  constructor(message, { retryable = false, ambiguous = false } = {}) {
    super(message);
    this.name = "SaveError";
    this.retryable = retryable; // هل تفيد إعادة المحاولة؟
    this.ambiguous = ambiguous; // هل ممكن السيرفر يكون حفظ رغم فشل الرد؟
  }
}

/** طلب POST واحد؛ يرجّع JSON أو يرمي SaveError (مع تحديد هل النتيجة غير معروفة). */
async function postToServer(fields, timeoutMs) {
  const body = new URLSearchParams();
  Object.entries(fields).forEach(([k, v]) => body.append(k, v));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let responseText;
  try {
    response = await fetch(WEB_APP_URL_POST, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: body.toString(),
      signal: controller.signal,
    });
    responseText = await response.text();
  } catch (error) {
    throw new SaveError(
      error.name === "AbortError" ? "انتهت مهلة الاتصال" : "انقطع الاتصال بالشبكة",
      { retryable: true, ambiguous: true }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  let data = null;
  try {
    data = JSON.parse(responseText);
  } catch (_) { /* رد غير JSON، مثل صفحة خطأ من Google */ }

  if (!data || typeof data !== "object") {
    throw new SaveError(`رد غير مفهوم من السيرفر (HTTP ${response.status})`, {
      retryable: true,
      ambiguous: true,
    });
  }
  return data;
}

/** هل السيرفر أكّد حفظ كل requestId؟ (لا نعتمد على success وحدها) */
function interpretServerReply(data, requestIds) {
  const results = Array.isArray(data.results) ? data.results : null;
  if (!results) {
    return {
      confirmed: false,
      retryable: false,
      message: "السيرفر لم يؤكد الحفظ. تأكد أن آخر نسخة من Apps Script منشورة (Deploy ← New version).",
    };
  }

  const confirmedIds = new Set(
    results
      .filter((r) => r && (r.status === "saved" || r.status === "duplicate") && r.requestId)
      .map((r) => r.requestId)
  );
  const allConfirmed = data.success === true && requestIds.every((id) => confirmedIds.has(id));
  if (allConfirmed) return { confirmed: true };

  const failed = results.find((r) => r && r.status === "error");
  return {
    confirmed: false,
    retryable: data.retryable === true,
    message: (failed && failed.error) || data.error || "السيرفر لم يؤكد حفظ التبرع",
  };
}

/** نسأل السيرفر: هل التبرعات دي اتحفظت فعلًا؟ (true / false / null = مش معروف) */
async function checkSavedOnServer(requestIds) {
  try {
    for (const id of requestIds) {
      const data = await postToServer({ action: "status", requestId: id }, STATUS_TIMEOUT_MS);
      if (data.success !== true) return null;
      if (data.found !== true) return false;
    }
    return true;
  } catch (_) {
    return null;
  }
}

/**
 * حفظ مضمون: لا يرجّع نجاح إلا بتأكيد صريح من السيرفر بأن السطر كُتب في الشيت.
 * عند أي انقطاع نسأل السيرفر قبل إعادة المحاولة، وكل المحاولات بنفس requestId.
 */
async function sendDonationPayload(payload) {
  const requestIds = payload.entries.map((e) => e.requestId);
  const fields = {
    campaign: payload.campaign,
    center: payload.center,
    entries: JSON.stringify(payload.entries),
  };

  let lastError = null;
  let statusUnknown = false;

  for (let attempt = 1; attempt <= POST_MAX_ATTEMPTS; attempt++) {
    try {
      const data = await postToServer(fields, POST_TIMEOUT_MS);
      const verdict = interpretServerReply(data, requestIds);
      if (verdict.confirmed) return { success: true, data };
      lastError = new SaveError(verdict.message, { retryable: verdict.retryable });
    } catch (err) {
      if (!(err instanceof SaveError)) throw err;
      lastError = err;
    }

    if (!lastError.retryable) break;

    if (lastError.ambiguous) {
      const saved = await checkSavedOnServer(requestIds);
      if (saved === true) return { success: true, data: { recovered: true } };
      statusUnknown = saved === null;
    }

    if (attempt < POST_MAX_ATTEMPTS) {
      await sleep(800 * Math.pow(2, attempt - 1) + Math.random() * 400);
    }
  }

  if (statusUnknown) {
    throw new SaveError(
      `${lastError.message}. لم نتمكن من التأكد هل اتحفظ. إعادة الإرسال آمنة ولن تسبب تكرارًا.`
    );
  }
  throw lastError;
}

function setSubmittingState(on) {
  isSubmitting = on;
  const btn = document.getElementById("submitBtn");
  const loader = btn.querySelector(".btn-loader");
  const text = btn.querySelector(".btn-text");
  const addEntryBtn = document.getElementById("addEntryBtn");
  const form = document.getElementById("donationForm");

  btn.disabled = on;
  if (on) {
    btn.setAttribute("aria-busy", "true");
    text.style.display = "none";
    loader.style.display = "inline-flex";
  } else {
    btn.removeAttribute("aria-busy");
    text.style.display = "inline";
    loader.style.display = "none";
  }

  if (addEntryBtn) addEntryBtn.disabled = on;
  if (form) form.classList.toggle("is-submitting", on);
  if (!on) {
    checkCanAddEntry();
    updateSubmitButton();
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  if (isSubmitting) return;

  if (pendingCompressions > 0) {
    showError("انتظر حتى ينتهي تجهيز صور الإيصالات.");
    return;
  }

  const campaign = document.getElementById("campaign").value;
  const center = document.getElementById("center").value;

  if (!campaign || !center) {
    showError("يرجى اختيار اسم الحملة والمركز");
    return;
  }

  const cards = Array.from(document.querySelectorAll(".entry-card:not(.is-saved)"));
  if (cards.length === 0) {
    showError("لا توجد تبرعات جديدة للتسجيل");
    return;
  }

  // تحقق شامل قبل أي إرسال
  const seenRefs = new Set();
  document.querySelectorAll(".entry-card.is-saved .ref-number").forEach((el) => {
    seenRefs.add(el.value.trim().toLowerCase());
  });

  const allErrors = [];
  cards.forEach((card, i) => {
    validateEntry(card, seenRefs).forEach((msg) => allErrors.push(`تبرع ${i + 1}: ${msg}`));
  });

  if (allErrors.length) {
    showError(allErrors.slice(0, 4).join(" • ") + (allErrors.length > 4 ? " …" : ""));
    const firstBad = document.querySelector(".field-error");
    if (firstBad) firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  hideError();
  setSubmittingState(true);

  const loaderText = document.querySelector("#submitBtn .btn-loader");
  let saved = 0;
  const failures = [];

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (loaderText) loaderText.textContent = `جاري الحفظ ${i + 1}/${cards.length}...`;

    card.classList.remove("is-failed");
    try {
      await sendDonationPayload({
        campaign,
        center,
        entries: [entryToPayload(card)],
      });
      card.classList.add("is-saved");
      card.querySelectorAll("input, select, button").forEach((el) => (el.disabled = true));
      saved++;
    } catch (error) {
      console.error("فشل حفظ تبرع:", error);
      card.classList.add("is-failed");
      failures.push(`تبرع ${i + 1}: ${error.message}`);
    }
  }

  if (loaderText) loaderText.textContent = "جاري الحفظ...";
  setSubmittingState(false);

  if (failures.length === 0) {
    const msgEl = document.getElementById("successMessage");
    if (msgEl) msgEl.textContent = `تم حفظ ${saved} تبرع بنجاح`;
    document.getElementById("successOverlay").style.display = "flex";
  } else {
    showError(
      `تم حفظ ${saved} من ${cards.length}. التبرعات التي فشلت لا تزال موجودة ويمكن إعادة إرسالها. ${failures[0]}`
    );
    showNotification("error", failures.join(" • "), 9000);
  }
}

// ============================================================
//  الإشعارات
// ============================================================

function showNotification(type, message, duration = 4500) {
  const container = document.getElementById("toastContainer");
  if (!container) {
    console[type === "error" ? "error" : "warn"](message);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast toast--${type || "info"}`;

  const icon = document.createElement("div");
  icon.className = "toast-icon";
  icon.textContent = type === "success" ? "✓" : type === "info" ? "i" : "!";

  const body = document.createElement("div");
  body.className = "toast-body";
  body.textContent = message; // textContent بدل innerHTML لمنع حقن HTML

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "إغلاق");
  close.textContent = "×";

  toast.append(icon, body, close);
  container.appendChild(toast);

  let hidden = false;
  const hide = () => {
    if (hidden) return;
    hidden = true;
    toast.style.animation = "toastOut 0.18s ease forwards";
    setTimeout(() => toast.remove(), 200);
  };

  close.addEventListener("click", hide);
  setTimeout(hide, duration);
}

function showError(message) {
  const errorBox = document.getElementById("errorMessage");
  if (errorBox) {
    errorBox.textContent = message;
    errorBox.style.display = "block";
  }
  showNotification("warning", message, 6000);
}

function hideError() {
  const errorBox = document.getElementById("errorMessage");
  if (errorBox) {
    errorBox.textContent = "";
    errorBox.style.display = "none";
  }
}

// ============================================================
//  التهيئة
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  if (location.protocol === "file:") {
    const overlay = document.getElementById("loadingOverlay");
    if (overlay) overlay.classList.add("hidden");
    showError("⚠️ يرجى فتح الصفحة عبر خادم (http/https) وليس مباشرة من الملف.");
    return;
  }

  const campaign = document.getElementById("campaign");
  const center = document.getElementById("center");

  if (campaign) campaign.addEventListener("change", checkCanAddEntry);

  if (center) {
    center.addEventListener("change", () => {
      clearVolunteerData();
      refreshAllLists();
      checkCanAddEntry();
    });
  }

  const addBtn = document.getElementById("addEntryBtn");
  if (addBtn) addBtn.addEventListener("click", createEntry);

  const form = document.getElementById("donationForm");
  if (form) form.addEventListener("submit", handleSubmit);

  const newBtn = document.getElementById("newSubmission");
  if (newBtn) newBtn.addEventListener("click", () => location.reload());

  // تحذير عند مغادرة الصفحة أثناء الحفظ
  window.addEventListener("beforeunload", (e) => {
    // أثناء الحفظ، أو لو فيه تبرعات فشل حفظها وما زالت على الشاشة
    if (isSubmitting || document.querySelector(".entry-card.is-failed")) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  checkCanAddEntry();
  updateSubmitButton();
  loadAllData();
});
