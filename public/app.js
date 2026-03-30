const itemsInput = document.getElementById('itemsInput');
const findButton = document.getElementById('findButton');
const loading = document.getElementById('loading');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const errorBox = document.getElementById('error');
const results = document.getElementById('results');
const sellerName = document.getElementById('sellerName');
const itemCount = document.getElementById('itemCount');
const totalPrice = document.getElementById('totalPrice');
const onlineStatus = document.getElementById('onlineStatus');
const itemsList = document.getElementById('itemsList');
const unavailableWrap = document.getElementById('unavailableWrap');
const unavailableList = document.getElementById('unavailableList');
const copyWhisperButton = document.getElementById('copyWhisper');
const copyFeedback = document.getElementById('copyFeedback');
const dataMeta = document.getElementById('dataMeta');

let bestSellerState = null;
let progressTimer = null;

function setLoading(isLoading) {
  findButton.disabled = isLoading;
  loading.classList.toggle('hidden', !isLoading);
  progressWrap.classList.toggle('hidden', !isLoading);

  if (isLoading) {
    let progress = 5;
    progressBar.style.width = `${progress}%`;
    progressTimer = setInterval(() => {
      progress = Math.min(progress + Math.random() * 12, 92);
      progressBar.style.width = `${progress}%`;
    }, 180);
  } else {
    clearInterval(progressTimer);
    progressBar.style.width = '100%';
    setTimeout(() => {
      progressWrap.classList.add('hidden');
      progressBar.style.width = '0%';
    }, 250);
  }
}

function setError(message) {
  errorBox.textContent = message;
  errorBox.classList.toggle('hidden', !message);
}

function renderUnavailable(unavailableItems) {
  unavailableList.innerHTML = '';
  if (!unavailableItems?.length) {
    unavailableWrap.classList.add('hidden');
    return;
  }

  unavailableItems.forEach((entry) => {
    const li = document.createElement('li');
    li.textContent = `${entry.item}: ${entry.reason}`;
    unavailableList.appendChild(li);
  });
  unavailableWrap.classList.remove('hidden');
}

function renderResult(payload) {
  bestSellerState = payload.bestSeller;
  sellerName.textContent = payload.bestSeller.username;
  itemCount.textContent = `${payload.bestSeller.itemCount} / ${payload.requestedItemCount}`;
  totalPrice.textContent = `${payload.bestSeller.totalPrice} platinum`;
  onlineStatus.textContent = payload.bestSeller.online ? 'Online (In-Game)' : 'Offline';

  itemsList.innerHTML = '';
  payload.bestSeller.items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = `${item.name} — ${item.platinum}p`;
    itemsList.appendChild(li);
  });

  renderUnavailable(payload.unavailableItems);

  if (payload.meta) {
    dataMeta.textContent = `Dados: ${payload.meta.cacheHits} cache hit(s), ${payload.meta.cacheMisses} consulta(s) ao market.`;
  } else {
    dataMeta.textContent = '';
  }

  results.classList.remove('hidden');
}

async function findBestSeller() {
  const items = itemsInput.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (!items.length) {
    setError('Please paste at least one item.');
    return;
  }

  setError('');
  copyFeedback.textContent = '';
  setLoading(true);

  try {
    const response = await fetch('/api/best-seller', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to retrieve sellers.');
    }

    renderResult(data);
  } catch (error) {
    results.classList.add('hidden');
    setError(error.message || 'Unexpected error.');
  } finally {
    setLoading(false);
  }
}

async function copyWhisper() {
  if (!bestSellerState) {
    return;
  }

  const itemNames = bestSellerState.items.map((item) => item.name).join(', ');
  const message = `/w ${bestSellerState.username} Hi! I want to buy: ${itemNames} (VoidTrader)`;

  try {
    await navigator.clipboard.writeText(message);
    copyFeedback.textContent = 'Whisper message copied to clipboard.';
  } catch {
    copyFeedback.textContent = message;
  }
}

findButton.addEventListener('click', findBestSeller);
copyWhisperButton.addEventListener('click', copyWhisper);
