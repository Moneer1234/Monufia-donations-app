// ====================== الإعدادات ======================
const WEB_APP_URL_GET = "https://script.google.com/macros/s/AKfycbxmzqRPHjrvDYrClik3bn7OBI-saQvO8c4RtSZ6AZfeguTbUV57CPNaRE9rOrlpSMQj/exec"; // رابط شيت 1 (للقراءة)
const WEB_APP_URL_POST = "https://script.google.com/macros/s/AKfycbzVwUuZ2YSwBFz9C1OTIG4RhbqgWgjhNZP4JQPimiwtXaFi28rbzzSzdXqSat3BO-9X/exec"; // رابط شيت 2 (للكتابة)

// ====================== المتغيرات العامة ======================
let entryCount = 0;
let allVolunteers = [];
let allReceiptTypes = [];
let allIntentions = [];
let allCampaigns = [];
let allCenters = [];
let allDonorCodes = [];
let isSubmitting = false;

const MAX_IMAGE_SIZE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB
const POST_TIMEOUT_MS = 60000;

// ====================== تحميل البيانات ======================
async function loadAllData() {
  try {
    const [
      campaigns,
      centers,
      receiptTypes,
      intentions,
      volunteers,
      donorCodes,
    ] = await Promise.all([
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
    updateSubmitButton();

    // ===== إخفاء شاشة التحميل =====
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
      loadingOverlay.classList.add('hidden');
    }

  } catch (error) {
    console.error("خطأ في تحميل البيانات:", error);
    showError(
      "فشل تحميل البيانات من Google Sheets. تأكد من اتصالك بالإنترنت وأن Web App منشور بشكل صحيح.",
    );

    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
      loadingOverlay.classList.add('hidden');
    }
  }
}

async function fetchData(sheet) {
  // Fetch with retries and timeout to handle transient network errors
  const url = `${WEB_APP_URL_GET}?sheet=${encodeURIComponent(sheet)}`;
  const maxAttempts = 3;
  const baseDelay = 600; // ms
  const timeoutMs = 8000; // per-request timeout

  const fetchWithTimeout = (resource, ms) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    return fetch(resource, { signal: controller.signal })
      .finally(() => clearTimeout(id));
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchWithTimeout(url, timeoutMs);
      if (!response.ok) {
        const msg = `فشل تحميل ${sheet}: HTTP ${response.status}`;
        console.warn(msg);
        if (attempt === maxAttempts) {
          showNotification('error', msg, 7000);
          throw new Error(msg);
        }
        // otherwise retry
      } else {
        const data = await response.json();
        return Array.isArray(data) ? data : [];
      }
    } catch (err) {
      // handle AbortError differently
      const isAbort = err.name === 'AbortError';
      console.error(`Attempt ${attempt} failed for ${sheet}:`, err);
      if (attempt === maxAttempts) {
        const userMsg = isAbort
          ? `انتهت مهلة الاتصال عند تحميل ${sheet} (timeout)`
          : `فشل الاتصال أو حدث خطأ عند تحميل ${sheet}: ${err.message || err}`;
        try { showNotification('error', userMsg, 8000); } catch (e) { console.error(e); }
        return [];
      }

      // exponential backoff before next attempt
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
      // continue to next attempt
    }
  }
  return [];
}

function populateSelect(selectId, data) {
  const select = document.getElementById(selectId);
  if (!select) return;

  select.innerHTML = `<option value="">اختر ${select.previousElementSibling ? select.previousElementSibling.textContent : ""}</option>`;

  data.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.name || item.id || item.donorCode || item;
    option.textContent = item.name || item.donorCode || item;
    select.appendChild(option);
  });
}

// ====================== إدارة المتطوعين ======================
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

    const donorCodeDatalist = entry.querySelector(".donor-code-list");
    if (donorCodeDatalist) {
      donorCodeDatalist.innerHTML = "";
      allDonorCodes.forEach((code) => {
        const option = document.createElement("option");
        option.value = code.donorCode || code.name || code;
        option.textContent = code.donorCode || code.name || code;
        donorCodeDatalist.appendChild(option);
      });
    }
  });
}

// ====================== مسح بيانات المتطوعين عند تغيير المركز ======================
function clearVolunteerData() {
  document.querySelectorAll(".entry-card").forEach((entry) => {
    const volunteerNameInput = entry.querySelector(".volunteer-name");
    const volunteerPhoneInput = entry.querySelector(".volunteer-phone");

    if (volunteerNameInput) {
      volunteerNameInput.value = "";
    }
    if (volunteerPhoneInput) {
      volunteerPhoneInput.value = "";
    }
  });
}

// ====================== التحقق من إمكانية إضافة تبرع ======================
function checkCanAddEntry() {
  const campaign = document.getElementById("campaign");
  const center = document.getElementById("center");
  const addBtn = document.getElementById("addEntryBtn");

  if (!campaign || !center || !addBtn) return;

  const hasCampaign = campaign.value && campaign.value !== "";
  const hasCenter = center.value && center.value !== "";

  if (hasCampaign && hasCenter) {
    addBtn.disabled = false;
    addBtn.title = "إضافة تبرع جديد";
    addBtn.style.opacity = "1";
    addBtn.style.cursor = "pointer";
  } else {
    addBtn.disabled = true;
    addBtn.title = "يرجى اختيار اسم الحملة والمركز أولاً";
    addBtn.style.opacity = "0.5";
    addBtn.style.cursor = "not-allowed";
  }
}

// ====================== إنشاء بطاقات التبرع ======================
function isValidOptionValue(inputEl, datalistEl) {
  if (!inputEl || !datalistEl) return false;

  const typedValue = inputEl.value.trim();
  if (!typedValue) return false;

  return Array.from(datalistEl.options).some(
    (option) => option.value.trim() === typedValue,
  );
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
        <div class="entry-card" id="entry-${entryCount}">
            <div class="entry-card-header">
                <span class="entry-number">تبرع ${entryCount}</span>
                <button type="button" class="btn-remove" onclick="removeEntry(${entryCount})">×</button>
            </div>
            
            <div class="form-row">
                <div class="form-group half">
                    <label>اسم المتطوع</label>
                    <input type="text" class="volunteer-name" list="${volunteerListId}" placeholder="بحث عن المتطوع" autocomplete="off" required>
                    <datalist class="volunteer-list" id="${volunteerListId}"></datalist>
                </div>
                <div class="form-group half">
                    <label>رقم الهاتف</label>
                    <input type="tel" class="volunteer-phone" placeholder="010XXXXXXXX" inputmode="tel" pattern="[0-9]{10,}" required>
                </div>
            </div>
            
            <div class="form-row">
                <div class="form-group half">
                    <label>نوع الوصل</label>
                    <select class="receipt-type" required>
                        <option value="">اختر نوع الوصل</option>
                    </select>
                </div>
                <div class="form-group half">
                    <label>النية</label>
                    <select class="intention" required>
                        <option value="">اختر النية</option>
                    </select>
                </div>
            </div>
            
            <div class="form-row">
                <div class="form-group half">
                    <label>المبلغ (ج.م)</label>
                    <input type="number" class="amount" required min="1" placeholder="0">
                </div>
                <div class="form-group half">
                    <label>الرقم المرجعي</label>
                    <input type="text" class="ref-number" inputmode="text" placeholder="REF1234" required>
                </div>
            </div>
            
            <div class="form-row">
                <div class="form-group half">
                    <label>التاريخ</label>
                    <input type="date" class="entry-date" value="${today}" required>
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
                  <input type="file" class="receipt-image" accept=".jpg,.jpeg,.png,image/jpeg,image/png" required>
                    <span class="receipt-upload-text">اختر صورة</span>
                </label>
            </div>
        </div>
    `;

  container.insertAdjacentHTML("beforeend", entryHTML);
  const entryCard = container.lastElementChild;

  const receiptSelect = entryCard.querySelector(".receipt-type");
  const intentionSelect = entryCard.querySelector(".intention");

  populateSelectForElement(receiptSelect, allReceiptTypes);
  populateSelectForElement(intentionSelect, allIntentions);

  const donorCodeDatalist = entryCard.querySelector(".donor-code-list");
  if (donorCodeDatalist) {
    allDonorCodes.forEach((code) => {
      const option = document.createElement("option");
      option.value = code.donorCode || code.name || code;
      option.textContent = code.donorCode || code.name || code;
      donorCodeDatalist.appendChild(option);
    });
  }

  const donorCodeInput = entryCard.querySelector(".donor-code");
  if (donorCodeInput && donorCodeDatalist) {
    const updateDonorCodeSelection = () => {
      if (donorCodeInput.value.trim()) {
        donorCodeInput.setCustomValidity(
          isValidOptionValue(donorCodeInput, donorCodeDatalist)
            ? ""
            : "يرجى اختيار كود الحالة من القائمة المقترحة",
        );
      } else {
        donorCodeInput.setCustomValidity("");
      }
    };

    donorCodeInput.addEventListener("input", updateDonorCodeSelection);
    donorCodeInput.addEventListener("change", updateDonorCodeSelection);
    donorCodeInput.addEventListener("blur", updateDonorCodeSelection);
  }

  const fileInput = entryCard.querySelector(".receipt-image");
  const uploadText = entryCard.querySelector(".receipt-upload-text");
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) {
      uploadText.textContent = fileInput.files[0].name;
    }
  });

  const nameInput = entryCard.querySelector(".volunteer-name");
  const phoneInput = entryCard.querySelector(".volunteer-phone");
  const volunteerDatalist = entryCard.querySelector(".volunteer-list");

  const updateVolunteerSelection = () => {
    const match = Array.from(volunteerDatalist.options).find(
      (option) => option.value.trim() === nameInput.value.trim(),
    );

    if (match) {
      phoneInput.value = match.dataset.phone || "";
      nameInput.setCustomValidity("");
    } else {
      phoneInput.value = "";
      nameInput.setCustomValidity("يرجى اختيار اسم المتطوع من القائمة المقترحة");
    }
  };

  nameInput.addEventListener("input", updateVolunteerSelection);
  nameInput.addEventListener("change", updateVolunteerSelection);
  nameInput.addEventListener("blur", updateVolunteerSelection);

  refreshAllLists();
  updateSubmitButton();

  setTimeout(() => {
    entryCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
}

function populateSelectForElement(select, data) {
  select.innerHTML = `<option value="">اختر ${select.previousElementSibling ? select.previousElementSibling.textContent : ""}</option>`;

  data.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.name || item.id || item;
    option.textContent = item.name || item;
    select.appendChild(option);
  });
}

function removeEntry(id) {
  document.getElementById(`entry-${id}`).remove();
  updateSubmitButton();
}

function updateSubmitButton() {
  const count = document.querySelectorAll(".entry-card").length;
  const btn = document.getElementById("submitBtn");
  const text = btn.querySelector(".btn-text");

  if (count === 0) {
    text.textContent = "لا توجد تبرعات";
    btn.disabled = true;
  } else {
    text.textContent = `تسجيل الكل (${count} تبرعات)`;
    btn.disabled = false;
  }
}

// ====================== تحويل الصورة إلى Base64 ======================
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve(null);
      return;
    }

    if (!file.type || !file.type.startsWith("image/")) {
      reject(new Error("الملف المختار ليس صورة مدعومة. اختر صورة JPG أو PNG."));
      return;
    }

    const img = new Image();
    const reader = new FileReader();

    const finish = (dataUrl, width, height) => {
      try {
        const maxWidth = 1200;
        const maxHeight = 1200;
        const scale = Math.min(1, maxWidth / width, maxHeight / height);
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const mimeType = "image/jpeg";
        let quality = 0.85;
        let compressedDataUrl = canvas.toDataURL(mimeType, quality);

        while (compressedDataUrl.length * 0.75 > MAX_IMAGE_SIZE_BYTES && quality > 0.35) {
          quality -= 0.1;
          compressedDataUrl = canvas.toDataURL(mimeType, quality);
        }

        if (compressedDataUrl.length * 0.75 > MAX_IMAGE_SIZE_BYTES) {
          throw new Error("تعذر ضغط صورة الإيصال إلى أقل من 1.5 ميجا بايت.");
        }

        resolve({
          base64: compressedDataUrl.split(",")[1],
          mimeType,
          fileName: `${file.name.replace(/\.[^/.]+$/, "")}.jpg`,
        });
      } catch (error) {
        reject(error);
      }
    };

    img.onload = () => {
      finish(reader.result, img.width, img.height);
    };

    img.onerror = () => {
      reject(new Error("تعذّر قراءة الصورة. اختر صورة JPG أو PNG من معرض الهاتف."));
    };

    reader.onerror = () => reject(new Error("تعذّر قراءة ملف الصورة من الجهاز."));
    reader.onload = () => {
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function sendDonationPayload(payload) {
  const formData = new URLSearchParams();
  formData.append("campaign", payload.campaign);
  formData.append("center", payload.center);
  formData.append("entries", JSON.stringify(payload.entries));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);

  try {
    const response = await fetch(WEB_APP_URL_POST, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: formData.toString(),
      signal: controller.signal,
    });

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = null;
    }

    const normalizedResponseText = responseText.trim().toLowerCase();
    const isSuccessful = response.ok && (
      normalizedResponseText === "success" ||
      (responseData && (
        responseData.success === true ||
        responseData.success === "true" ||
        String(responseData.status || "").toLowerCase() === "success"
      ))
    );

    if (isSuccessful) {
      // وحّد شكل الرد حتى لا تعتبر الواجهة رد "success" النصّي فشلًا.
      return responseData && typeof responseData === "object"
        ? { ...responseData, success: true }
        : { success: true };
    }

    const errorMessage = responseData && (responseData.error || responseData.message);
    throw new Error(errorMessage || `HTTP ${response.status}: ${responseText.slice(0, 200)}`);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("انتهت مهلة الاتصال. قد يكون الطلب قيد الحفظ، لذلك لا تعاود الإرسال قبل مراجعة الشيت.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ====================== إرسال البيانات (إلى شيت 2) ======================
document.getElementById("donationForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const errorBox = document.getElementById("errorMessage");
  const btn = document.getElementById("submitBtn");
  const loader = btn.querySelector(".btn-loader");
  const text = btn.querySelector(".btn-text");
  const addEntryBtn = document.getElementById("addEntryBtn");
  const form = document.getElementById("donationForm");

  if (isSubmitting) {
    return;
  }

  // التحقق من الحقول الأساسية
  const campaign = document.getElementById("campaign").value;
  const center = document.getElementById("center").value;

  if (!campaign || !center) {
    showError("يرجى اختيار اسم الحملة والمركز");
    return;
  }

  const entryCards = document.querySelectorAll(".entry-card");
  let hasMissingFields = false;

  entryCards.forEach((entry) => {
    const volunteerNameInput = entry.querySelector(".volunteer-name");
    const volunteerDatalist = entry.querySelector(".volunteer-list");
    const donorCodeInput = entry.querySelector(".donor-code");
    const donorCodeDatalist = entry.querySelector(".donor-code-list");
    const fields = [
      volunteerNameInput,
      entry.querySelector(".volunteer-phone"),
      entry.querySelector(".receipt-type"),
      entry.querySelector(".intention"),
      entry.querySelector(".amount"),
      entry.querySelector(".ref-number"),
      entry.querySelector(".entry-date"),
      entry.querySelector(".receipt-image"),
    ];

    fields.forEach((field) => {
      if (field && !field.value) {
        hasMissingFields = true;
        field.style.borderColor = "red";
      } else if (field) {
        field.style.borderColor = "";
      }
    });

    if (volunteerNameInput && volunteerDatalist && !isValidOptionValue(volunteerNameInput, volunteerDatalist)) {
      hasMissingFields = true;
      volunteerNameInput.style.borderColor = "red";
    }

    if (donorCodeInput && donorCodeDatalist && donorCodeInput.value.trim() && !isValidOptionValue(donorCodeInput, donorCodeDatalist)) {
      hasMissingFields = true;
      donorCodeInput.style.borderColor = "red";
    }
  });

  if (hasMissingFields) {
    showError("يرجى ملء جميع الحقول المطلوبة قبل تسجيل التبرعات");
    return;
  }

  errorBox.textContent = "";
  errorBox.style.display = "none";

  // تفعيل حالة التحميل
  isSubmitting = true;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  text.style.display = "none";
  loader.style.display = "inline-block";

  if (addEntryBtn) {
    addEntryBtn.disabled = true;
    addEntryBtn.style.opacity = "0.6";
    addEntryBtn.style.cursor = "not-allowed";
  }

  if (form) {
    form.classList.add("is-submitting");
  }

  try {
    // تجميع البيانات
    const data = {
      campaign: campaign,
      center: center,
      entries: [],
    };

    for (const entry of entryCards) {
      const file = entry.querySelector(".receipt-image").files[0];
      let compressedImage = null;

      try {
        compressedImage = file ? await fileToBase64(file) : null;
      } catch (fileError) {
        console.error("خطأ في صورة الإيصال:", fileError);
        throw new Error(fileError.message || "حدث خطأ في صورة الإيصال");
      }

      data.entries.push({
        volunteerName: entry.querySelector(".volunteer-name").value,
        volunteerPhone: entry.querySelector(".volunteer-phone").value,
        receiptType: entry.querySelector(".receipt-type").value,
        intention: entry.querySelector(".intention").value,
        amount: entry.querySelector(".amount").value,
        refNumber: entry.querySelector(".ref-number").value,
        date: entry.querySelector(".entry-date").value,
        donorCode: entry.querySelector(".donor-code").value || "",
        receiptImageBase64: compressedImage ? compressedImage.base64 : null,
        receiptImageName: compressedImage ? compressedImage.fileName : "",
        receiptImageType: compressedImage ? compressedImage.mimeType : "",
      });
    }

    const responseData = await sendDonationPayload(data);

    if (responseData && responseData.success === true) {
      document.getElementById("successOverlay").style.display = "flex";
    } else {
      const msg = (responseData && responseData.error) || "حدث خطأ أثناء الحفظ";
      showError(`فشل حفظ البيانات: ${msg}`);
    }
  } catch (error) {
    console.error("خطأ:", error);
    const detail = error && error.message ? ` ${error.message}` : "";
    showError(
      `تعذر إرسال البيانات${detail}. حاول تقليل حجم الصورة أو إعادة المحاولة بعد قليل.`,
    );
  }

  // إعادة تعيين حالة الزر
  isSubmitting = false;
  btn.disabled = false;
  btn.removeAttribute("aria-busy");
  text.style.display = "inline";
  loader.style.display = "none";

  if (addEntryBtn) {
    addEntryBtn.disabled = false;
    addEntryBtn.style.opacity = "1";
    addEntryBtn.style.cursor = "pointer";
  }

  if (form) {
    form.classList.remove("is-submitting");
  }
});

// Global notification / toast helper
function showNotification(type, message, duration = 4500) {
  const container = document.getElementById("toastContainer");
  if (!container) {
    // fallback
    console[type === 'error' ? 'error' : 'warn'](message);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast toast--${type || 'info'}`;

  const icon = type === 'success' ? '✓' : type === 'error' ? '!' : type === 'warning' ? '!' : 'i';
  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">${message}</div>
    <button class="toast-close" aria-label="Close">×</button>
  `;

  container.appendChild(toast);

  const hide = () => {
    toast.style.animation = 'toastOut 0.18s ease forwards';
    setTimeout(() => {
      if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
    }, 200);
  };

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', hide);

  setTimeout(hide, duration);
}

// Backwards-compatible showError using styled warning toast + inline error box
function showError(message) {
  const errorBox = document.getElementById("errorMessage");
  if (errorBox) {
    errorBox.textContent = message;
    errorBox.style.display = "block";
  }
  showNotification('warning', message, 5000);
}

// ====================== إعادة التحميل ======================
document.getElementById("newSubmission").addEventListener("click", () => {
  location.reload();
});

// ====================== التهيئة ======================
document.addEventListener("DOMContentLoaded", () => {
  if (location.protocol === "file:") {
    showError("⚠️ يرجى فتح الصفحة عبر خادم محلي (http://localhost) وليس مباشرة من الملف.");
    return;
  }

  const campaign = document.getElementById("campaign");
  const center = document.getElementById("center");

  if (campaign) {
    campaign.addEventListener("change", checkCanAddEntry);
  }

  if (center) {
    center.addEventListener("change", function () {
      // ===== مسح بيانات المتطوعين أولاً =====
      clearVolunteerData();
      
      // ===== ثم تحديث القوائم =====
      refreshAllLists();
      checkCanAddEntry();
    });
  }

  const addBtn = document.getElementById("addEntryBtn");
  if (addBtn) {
    addBtn.addEventListener("click", createEntry);
  }

  loadAllData();
  setTimeout(checkCanAddEntry, 500);
});