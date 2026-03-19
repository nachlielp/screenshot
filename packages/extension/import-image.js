import { saveCapture } from './utils/db.js';

const dropzone = document.getElementById('dropzone');
const imageInput = document.getElementById('imageInput');
const chooseFileBtn = document.getElementById('chooseFileBtn');
const pasteImageBtn = document.getElementById('pasteImageBtn');

const openInEditor = async (blob, source = 'local-image') => {
    if (!blob || !blob.type.startsWith('image/')) {
        throw new Error('Please provide an image file');
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const captureId = crypto.randomUUID();
    const extension = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const filename = `${source}-${timestamp}.${extension}`;

    await saveCapture(captureId, blob, filename, blob.type, null, null, null, {
        captureSurface: source,
        timestamp: new Date().toISOString(),
    });

    const editorUrl = chrome.runtime.getURL(`editor.html?id=${captureId}`);
    window.location.href = editorUrl;
};

const importFile = async (file, source = 'local-image') => {
    if (!file || !file.type.startsWith('image/')) return;
    await openInEditor(file, source);
};

const tryPasteClipboardImage = async () => {
    if (!navigator.clipboard?.read) {
        imageInput.click();
        return;
    }

    const items = await navigator.clipboard.read();
    for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (!imageType) continue;

        const blob = await item.getType(imageType);
        await openInEditor(blob, 'clipboard-image');
        return;
    }

    imageInput.click();
};

chooseFileBtn.addEventListener('click', () => {
    imageInput.click();
});

pasteImageBtn.addEventListener('click', async () => {
    try {
        await tryPasteClipboardImage();
    } catch (error) {
        console.error('Clipboard image import failed:', error);
        imageInput.click();
    }
});

imageInput.addEventListener('change', async () => {
    try {
        await importFile(imageInput.files?.[0], 'local-image');
    } catch (error) {
        console.error('Selected image import failed:', error);
    } finally {
        imageInput.value = '';
    }
});

document.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('drag-over');
});

document.addEventListener('dragleave', (event) => {
    if (event.target === document.documentElement || event.target === document.body) {
        dropzone.classList.remove('drag-over');
    }
});

document.addEventListener('drop', async (event) => {
    event.preventDefault();
    dropzone.classList.remove('drag-over');

    const file = event.dataTransfer?.files?.[0];
    if (!file) return;

    try {
        await importFile(file, 'local-image');
    } catch (error) {
        console.error('Dropped image import failed:', error);
    }
});

document.addEventListener('paste', async (event) => {
    const item = Array.from(event.clipboardData?.items || []).find((entry) => entry.type.startsWith('image/'));
    if (!item) return;

    event.preventDefault();
    try {
        await importFile(item.getAsFile(), 'clipboard-image');
    } catch (error) {
        console.error('Pasted image import failed:', error);
    }
});
