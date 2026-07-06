// ====================== الإعدادات ======================
const WEB_APP_URL_GET = "https://script.google.com/macros/s/AKfycbxmzqRPHjrvDYrClik3bn7OBI-saQvO8c4RtSZ6AZfeguTbUV57CPNaRE9rOrlpSMQj/exec"; // رابط شيت 1 (للقراءة)
const WEB_APP_URL_POST = "https://script.google.com/macros/s/AKfycbxkdIKYLO9TBcR8aCPZZUnTqSQFJs2bqUUcDJ0rqiMLHSZk_lux-JLMryE1khYueEvq/exec"; // رابط شيت 2 (للكتابة)

// ====================== المتغيرات العامة ======================
let entryCount = 0;
let allVolunteers = [];
let allReceiptTypes = [];
let allIntentions = [];
let allCampaigns = [];
let allCenters = [];
let allDonorCodes = [];

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
  try {
    const url = `${WEB_APP_URL_GET}?sheet=${encodeURIComponent(sheet)}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error(`خطأ في تحميل ${sheet}:`, error);
    return [];
  }
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
function createEntry() {
  const campaign = document.getElementById("campaign");
  const center = document.getElementById("center");

  if (!campaign || !center || !campaign.value || !center.value) {
    showError("⚠️ يرجى اختيار اسم الحملة والمركز أولاً قبل إضافة تبرع");
    alert("⚠️ يرجى اختيار اسم الحملة والمركز أولاً قبل إضافة تبرع");
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
                    <input type="file" class="receipt-image" accept="image/*" required>
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

  nameInput.addEventListener("input", () => {
    const match = Array.from(volunteerDatalist.options).find(
      (o) => o.value === nameInput.value,
    );
    if (match && match.dataset.phone) {
      phoneInput.value = match.dataset.phone;
    }
  });

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
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ====================== إرسال البيانات (إلى شيت 2) ======================
document.getElementById("donationForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const errorBox = document.getElementById("errorMessage");
  const btn = document.getElementById("submitBtn");
  const loader = btn.querySelector(".btn-loader");
  const text = btn.querySelector(".btn-text");

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
    const fields = [
      entry.querySelector(".volunteer-name"),
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
  });

  if (hasMissingFields) {
    showError("يرجى ملء جميع الحقول المطلوبة قبل تسجيل التبرعات");
    return;
  }

  errorBox.textContent = "";
  errorBox.style.display = "none";

  // تفعيل حالة التحميل
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  text.style.display = "none";
  loader.style.display = "inline-block";

  try {
    // تجميع البيانات
    const data = {
      campaign: campaign,
      center: center,
      entries: [],
    };

    for (const entry of entryCards) {
      const file = entry.querySelector(".receipt-image").files[0];
      const base64 = file ? await fileToBase64(file) : null;

      data.entries.push({
        volunteerName: entry.querySelector(".volunteer-name").value,
        volunteerPhone: entry.querySelector(".volunteer-phone").value,
        receiptType: entry.querySelector(".receipt-type").value,
        intention: entry.querySelector(".intention").value,
        amount: entry.querySelector(".amount").value,
        refNumber: entry.querySelector(".ref-number").value,
        date: entry.querySelector(".entry-date").value,
        donorCode: entry.querySelector(".donor-code").value || "",
        receiptImageBase64: base64,
        receiptImageName: file ? file.name : "",
        receiptImageType: file ? file.type : "",
      });
    }

    // إرسال إلى شيت 2 (للكتابة)
    const formData = new URLSearchParams();
    formData.append('campaign', data.campaign);
    formData.append('center', data.center);
    formData.append('entries', JSON.stringify(data.entries));

    const response = await fetch(WEB_APP_URL_POST, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData,
    });

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { success: false, error: responseText };
    }

    if (responseData && responseData.success) {
      document.getElementById("successOverlay").style.display = "flex";
    } else {
      const msg = (responseData && responseData.error) || "حدث خطأ أثناء الحفظ";
      showError(`فشل حفظ البيانات: ${msg}`);
    }
  } catch (error) {
    console.error("خطأ:", error);
    showError(
      "تعذر الاتصال بـ Apps Script. تأكد من اتصالك بالإنترنت وأن Web App منشور بشكل صحيح.",
    );
  }

  // إعادة تعيين حالة الزر
  btn.disabled = false;
  btn.removeAttribute("aria-busy");
  text.style.display = "inline";
  loader.style.display = "none";
});

function showError(message) {
  const errorBox = document.getElementById("errorMessage");
  errorBox.textContent = message;
  errorBox.style.display = "block";
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