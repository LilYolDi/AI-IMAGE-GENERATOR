
const promptInput = document.getElementById("promptInput");
const sendBtn = document.getElementById("sendBtn");
const chatMessages = document.getElementById("chatMessages");
const welcome = document.getElementById("welcome");
const generatorPage = document.getElementById("generatorPage");
const galleryPage = document.getElementById("galleryPage");
const galleryGrid = document.getElementById("galleryGrid");
const emptyGallery = document.getElementById("emptyGallery");
const toast = document.getElementById("toast");

// ---------- Референсное изображение ----------

const referenceInput = document.getElementById("referenceInput");
const attachImageBtn = document.getElementById("attachImageBtn");
const referencePreview = document.getElementById("referencePreview");
const referencePreviewImage = document.getElementById("referencePreviewImage");
const referenceFileName = document.getElementById("referenceFileName");
const removeReferenceBtn = document.getElementById("removeReferenceBtn");

let selectedReference = null;
let referencePreviewUrl = null;

function showReferencePreview(file) {
  if (!file) return;

  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    showToast("Выбери изображение PNG, JPEG или WEBP.");
    return;
  }

  if (file.size > 20 * 1024 * 1024) {
    showToast("Размер фотографии не должен превышать 20 МБ.");
    return;
  }

  selectedReference = file;

  if (referencePreviewUrl) {
    URL.revokeObjectURL(referencePreviewUrl);
  }

  referencePreviewUrl = URL.createObjectURL(file);

  referencePreviewImage.src = referencePreviewUrl;
  referenceFileName.textContent = file.name;

  referencePreview.classList.remove("hidden");
}

function removeReference() {
  selectedReference = null;

  if (referencePreviewUrl) {
    URL.revokeObjectURL(referencePreviewUrl);
    referencePreviewUrl = null;
  }

  referencePreviewImage.removeAttribute("src");
  referenceFileName.textContent = "";
  referencePreview.classList.add("hidden");

  if (referenceInput) {
    referenceInput.value = "";
  }
}

if (attachImageBtn && referenceInput) {
  attachImageBtn.addEventListener("click", () => {
    referenceInput.click();
  });

  referenceInput.addEventListener("change", () => {
    const file = referenceInput.files?.[0];

    if (file) {
      showReferencePreview(file);
    }
  });
}

if (removeReferenceBtn) {
  removeReferenceBtn.addEventListener("click", removeReference);
}

let messages = [];
let busy = false;
let currentPage = "generator";
let db;

const DB_NAME = "AIImageGenerator";
const DB_VERSION = 1;

// ---------- Локальная база данных ----------

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains("images")) {
        database.createObjectStore("images", {
          keyPath: "id"
        });
      }

      if (!database.objectStoreNames.contains("chats")) {
        database.createObjectStore("chats", {
          keyPath: "id"
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function saveImage(image) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("images", "readwrite");
    transaction.objectStore("images").put(image);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function getImage(id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("images", "readonly");
    const request = transaction.objectStore("images").get(id);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllImages() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("images", "readonly");
    const request = transaction.objectStore("images").getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function deleteImage(id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("images", "readwrite");
    transaction.objectStore("images").delete(id);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function saveChat() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("chats", "readwrite");

    transaction.objectStore("chats").put({
      id: "current",
      messages
    });

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function loadChat() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("chats", "readonly");
    const request = transaction.objectStore("chats").get("current");

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function clearChatStorage() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("chats", "readwrite");
    transaction.objectStore("chats").delete("current");

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function clearImageStorage() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("images", "readwrite");
    transaction.objectStore("images").clear();

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// ---------- Интерфейс ----------

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");

  setTimeout(() => {
    toast.classList.remove("show");
  }, 2800);
}

function showGenerator() {
  currentPage = "generator";

  generatorPage.classList.remove("hidden");
  galleryPage.classList.add("hidden");

  document.getElementById("pageTitle").textContent =
    "Генератор изображений";

  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.page === "generator"
    );
  });
}

async function showGallery() {
  currentPage = "gallery";

  generatorPage.classList.add("hidden");
  galleryPage.classList.remove("hidden");

  document.getElementById("pageTitle").textContent =
    "Моя галерея";

  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.page === "gallery"
    );
  });

  await renderGallery();
}

function updateWelcome() {
  welcome.classList.toggle("hidden", messages.length > 0);
}

function renderUserMessage(text) {
  const wrapper = document.createElement("div");
  wrapper.className = "message message-user";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  chatMessages.appendChild(wrapper);
}

function renderImageMessage(imageId, imageData, prompt) {
  const wrapper = document.createElement("div");
  wrapper.className = "message message-ai";

  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = "AI IMAGE GENERATOR";

  const image = document.createElement("img");
  image.className = "generated-image";
  image.src = imageData;
  image.alt = "Созданное изображение";

  const actions = document.createElement("div");
  actions.className = "image-actions";

  const download = document.createElement("button");
  download.textContent = "↓ Скачать";
  download.addEventListener("click", () => {
    downloadImage(imageData);
  });

  const edit = document.createElement("button");
  edit.textContent = "✎ Изменить";
  edit.addEventListener("click", () => {
    promptInput.value = "";
    promptInput.placeholder = "Что изменить на этом изображении?";
    promptInput.focus();
    promptInput.dataset.editImageId = imageId;
  });

  const gallery = document.createElement("button");
  gallery.textContent = "▦ Галерея";
  gallery.addEventListener("click", showGallery);

  actions.append(download, edit, gallery);
  wrapper.append(label, image, actions);

  chatMessages.appendChild(wrapper);
}

function renderLoading() {
  const loading = document.createElement("div");
  loading.className = "message loading";
  loading.id = "loadingMessage";
  loading.textContent = "✦ Создаю изображение...";

  chatMessages.appendChild(loading);
}

function removeLoading() {
  document.getElementById("loadingMessage")?.remove();
}

function scrollChat() {
  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: "smooth"
  });
}

async function addUserMessage(text) {
  messages.push({
    type: "user",
    text
  });

  renderUserMessage(text);
  updateWelcome();
  await saveChat();
}

async function addImageMessage(imageData, prompt) {
  const id = crypto.randomUUID();

  await saveImage({
    id,
    image: imageData,
    prompt,
    createdAt: Date.now()
  });

  messages.push({
    type: "image",
    imageId: id,
    prompt
  });

  renderImageMessage(id, imageData, prompt);
  updateWelcome();
  await saveChat();
}

// ---------- Генерация с референсным фото ----------

async function generateImage(prompt, referenceFile = null) {
  const form = new FormData();

  form.append("prompt", prompt);
  form.append(
    "size",
    document.getElementById("imageSize").value
  );
  form.append(
    "quality",
    document.getElementById("imageQuality").value
  );

  if (referenceFile) {
    form.append(
      "reference",
      referenceFile,
      referenceFile.name
    );
  }

  const response = await fetch("/api/generate", {
    method: "POST",
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Ошибка генерации.");
  }

  return data.image;
}

// ---------- Редактирование ----------

async function editImage(imageId, prompt) {
  const saved = await getImage(imageId);

  if (!saved) {
    throw new Error("Исходное изображение не найдено.");
  }

  const responseBlob = await fetch(saved.image);
  const blob = await responseBlob.blob();

  const form = new FormData();

  form.append("prompt", prompt);
  form.append("image", blob, "image.png");

  const response = await fetch("/api/edit", {
    method: "POST",
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Ошибка редактирования.");
  }

  return data.image;
}

// ---------- Отправка запроса ----------

async function sendPrompt() {
  const prompt = promptInput.value.trim();

  if (!prompt || busy) return;

  busy = true;
  sendBtn.disabled = true;

  const editImageId = promptInput.dataset.editImageId;
  const referenceFile = selectedReference;

  promptInput.value = "";
  delete promptInput.dataset.editImageId;
  promptInput.placeholder =
    "Опиши изображение или напиши, что изменить...";

  await addUserMessage(prompt);

  renderLoading();
  scrollChat();

  try {
    let result;

    if (editImageId && !referenceFile) {
  result = await editImage(editImageId, prompt);
} else {
  result = await generateImage(prompt, referenceFile);
}

    removeLoading();

    await addImageMessage(result, prompt);

    if (referenceFile && selectedReference === referenceFile) {
      removeReference();
    }

    showToast(
      editImageId
        ? "Изображение изменено!"
        : "Изображение создано!"
    );

  } catch (error) {
    removeLoading();

    const errorMessage = document.createElement("div");
    errorMessage.className = "message loading";
    errorMessage.textContent = "Ошибка: " + error.message;

    chatMessages.appendChild(errorMessage);

    showToast(error.message);

  } finally {
    busy = false;
    sendBtn.disabled = false;
    scrollChat();
  }
}

// ---------- Скачивание ----------

function downloadImage(imageData) {
  const link = document.createElement("a");

  link.href = imageData;
  link.download = `ai-image-${Date.now()}.png`;

  document.body.appendChild(link);
  link.click();
  link.remove();
}

// ---------- Галерея ----------

async function renderGallery() {
  const images = await getAllImages();

  galleryGrid.innerHTML = "";

  images.sort((a, b) => b.createdAt - a.createdAt);

  emptyGallery.classList.toggle("hidden", images.length > 0);

  for (const item of images) {
    const card = document.createElement("div");
    card.className = "gallery-card";

    const image = document.createElement("img");
    image.src = item.image;
    image.alt = "Сохранённое изображение";

    const content = document.createElement("div");
    content.className = "gallery-card-content";

    const description = document.createElement("p");
    description.textContent = item.prompt;

    const download = document.createElement("button");
    download.textContent = "Скачать";
    download.addEventListener("click", () => {
      downloadImage(item.image);
    });

    const edit = document.createElement("button");
    edit.textContent = "Изменить";
    edit.addEventListener("click", () => {
      showGenerator();
      promptInput.dataset.editImageId = item.id;
      promptInput.placeholder = "Что изменить на этом изображении?";
      promptInput.focus();
    });

    const remove = document.createElement("button");
    remove.textContent = "Удалить";
    remove.addEventListener("click", async () => {
      await deleteImage(item.id);

      messages = messages.filter(message =>
        message.imageId !== item.id
      );

      await saveChat();
      await renderGallery();

      showToast("Изображение удалено.");
    });

    content.append(
      description,
      download,
      edit,
      remove
    );

    card.append(image, content);
    galleryGrid.appendChild(card);
  }
}

// ---------- История чата ----------

async function restoreChat() {
  const saved = await loadChat();

  if (!saved || !Array.isArray(saved.messages)) return;

  messages = saved.messages;

  chatMessages.innerHTML = "";

  for (const message of messages) {
    if (message.type === "user") {
      renderUserMessage(message.text);
    }

    if (message.type === "image") {
      const image = await getImage(message.imageId);

      if (image) {
        renderImageMessage(
          image.id,
          image.image,
          message.prompt
        );
      }
    }
  }

  updateWelcome();
}

async function createNewChat() {
  if (busy) return;

  messages = [];
  chatMessages.innerHTML = "";

  await clearChatStorage();

  updateWelcome();
  showGenerator();

  promptInput.value = "";
  delete promptInput.dataset.editImageId;

  promptInput.placeholder =
    "Опиши изображение или напиши, что изменить...";
}

// ---------- События ----------

sendBtn.addEventListener("click", sendPrompt);

promptInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
  }
});

document.getElementById("newChatBtn").addEventListener(
  "click",
  createNewChat
);

document.getElementById("clearChatBtn").addEventListener(
  "click",
  createNewChat
);

document.querySelectorAll(".nav-item").forEach(button => {
  button.addEventListener("click", () => {
    if (button.dataset.page === "generator") {
      showGenerator();
    }

    if (button.dataset.page === "gallery") {
      showGallery();
    }
  });
});

document.querySelectorAll(".example-card").forEach(button => {
  button.addEventListener("click", () => {
    promptInput.value = button.dataset.prompt;
    promptInput.focus();
  });
});

document.getElementById("clearGalleryBtn").addEventListener(
  "click",
  async () => {
    if (!confirm("Удалить все изображения из галереи?")) return;

    await clearImageStorage();

    messages = messages.filter(message =>
      message.type !== "image"
    );

    await saveChat();
    await renderGallery();

    if (currentPage === "generator") {
      chatMessages.innerHTML = "";
      await restoreChat();
    }

    showToast("Галерея очищена.");
  }
);

document.getElementById("mobileMenu").addEventListener(
  "click",
  () => {
    document.getElementById("sidebar").classList.toggle("open");
  }
);

// ---------- Запуск ----------

async function initialize() {
  try {
    db = await openDatabase();

    await restoreChat();

    await renderGallery();

  } catch (error) {
    console.error(error);
    showToast("Не удалось открыть локальное хранилище.");
  }
}

initialize();
