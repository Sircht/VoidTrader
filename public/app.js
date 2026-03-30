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

const WFM_API_BASE = 'https://api.warframe.market/v1';
const CACHE_TTL_MS = 5 * 60 * 1000;
const IS_GITHUB_PAGES = window.location.hostname.endsWith('github.io');
const SERVER_API_BASE = window.VOIDTRADER_API_BASE || '';

let bestSellerState = null;
let progressTimer = null;
let itemIndexCache = { timestamp: 0, byName: new Map() };
const ordersCache = new Map();

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

function normalizeItemName(itemName) {
  return itemName
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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
    const mode = payload.meta.source || 'server';
    dataMeta.textContent = `Fonte: ${mode}. Cache hit(s): ${payload.meta.cacheHits || 0}.`;
    if (mode === 'github-pages-direct-api') {
      dataMeta.textContent += ' (modo GitHub Pages sem backend)';
    }
  } else {
    dataMeta.textContent = '';
  }

  results.classList.remove('hidden');
}

function compareSellers(a, b) {
  if (b.items.length !== a.items.length) return b.items.length - a.items.length;
  if (a.totalPrice !== b.totalPrice) return a.totalPrice - b.totalPrice;
  if (a.online !== b.online) return a.online ? -1 : 1;
  return a.username.localeCompare(b.username);
}

function isOnline(order) {
  const status = (order.user?.status || '').toLowerCase();
  return status === 'ingame' || status === 'online';
}

function selectBestOrderPerSeller(orders) {
  const perSeller = new Map();

  for (const order of orders) {
    if (!order || order.order_type !== 'sell' || order.visible === false) continue;

    const platform = (order.platform || order.user?.platform || '').toLowerCase();
    if (platform && platform !== 'pc') continue;

    const username = order.user?.ingame_name || order.user?.id;
    const platinum = Number(order.platinum);
    if (!username || !Number.isFinite(platinum) || platinum < 0) continue;

    const candidate = { username, platinum, online: isOnline(order) };
    const existing = perSeller.get(username);

    if (!existing || candidate.platinum < existing.platinum ||
      (candidate.platinum === existing.platinum && candidate.online && !existing.online)) {
      perSeller.set(username, candidate);
    }
  }

  return perSeller;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function getItemIndex() {
  if (Date.now() - itemIndexCache.timestamp < 60 * 60 * 1000 && itemIndexCache.byName.size) {
    return itemIndexCache.byName;
  }

  const data = await fetchJson(`${WFM_API_BASE}/items`);
  const index = new Map();
  const items = data?.payload?.items || [];

  items.forEach((item) => {
    const displayName = item.item_name || item.en?.item_name || item.url_name;
    if (!displayName || !item.url_name) return;
    index.set(normalizeItemName(displayName), item.url_name);
    index.set(normalizeItemName(item.url_name), item.url_name);
  });

  itemIndexCache = { timestamp: Date.now(), byName: index };
  return index;
}

function getOrderCache(slug) {
  const cached = ordersCache.get(slug);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    ordersCache.delete(slug);
    return null;
  }
  return cached;
}

async function fetchOrders(slug) {
  const cached = getOrderCache(slug);
  if (cached) return { orders: cached.orders, fromCache: true };

  const data = await fetchJson(`${WFM_API_BASE}/items/${encodeURIComponent(slug)}/orders`);
  const orders = data?.payload?.orders || [];
  ordersCache.set(slug, { timestamp: Date.now(), orders });
  return { orders, fromCache: false };
}

async function runClientMode(items) {
  const index = await getItemIndex();
  const slugToDisplay = new Map();

  items.forEach((name) => {
    const normalized = normalizeItemName(name);
    const slug = index.get(normalized) || normalized;
    if (slug) slugToDisplay.set(slug, name);
  });

  const slugs = [...slugToDisplay.keys()];
  const sellers = new Map();
  const unavailableItems = [];
  let cacheHits = 0;

  // throttle (3 req/s)
  for (let i = 0; i < slugs.length; i += 1) {
    const slug = slugs[i];
    const displayName = slugToDisplay.get(slug) || slug;

    try {
      const response = await fetchOrders(slug);
      if (response.fromCache) cacheHits += 1;

      const perSeller = selectBestOrderPerSeller(response.orders);
      if (!perSeller.size) {
        unavailableItems.push({ item: displayName, reason: 'No sell orders found' });
      }

      for (const order of perSeller.values()) {
        const seller = sellers.get(order.username) || {
          username: order.username,
          online: false,
          totalPrice: 0,
          items: []
        };

        seller.online = seller.online || order.online;
        seller.totalPrice += order.platinum;
        seller.items.push({ name: displayName, slug, platinum: order.platinum });
        sellers.set(order.username, seller);
      }
    } catch {
      unavailableItems.push({ item: displayName, reason: 'API request failed' });
    }

    if (i < slugs.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 340));
    }
  }

  const ranked = [...sellers.values()]
    .map((seller) => ({
      ...seller,
      totalPrice: Number(seller.totalPrice.toFixed(2)),
      itemCount: seller.items.length
    }))
    .sort(compareSellers);

  if (!ranked.length) throw new Error('No sellers found for provided items.');

  return {
    requestedItemCount: items.length,
    resolvedItemCount: slugs.length,
    unavailableItems,
    bestSeller: ranked[0],
    topSellers: ranked.slice(0, 10),
    meta: {
      source: 'github-pages-direct-api',
      cacheHits,
      cacheMisses: slugs.length - cacheHits,
      cacheTtlSeconds: CACHE_TTL_MS / 1000
    }
  };
}

async function requestViaServer(items) {
  const response = await fetch(`${SERVER_API_BASE}/api/best-seller`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  const payload = await response.json();
  payload.meta = { ...(payload.meta || {}), source: 'server-api' };
  return payload;
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
    let payload;

    if (IS_GITHUB_PAGES && !SERVER_API_BASE) {
      payload = await runClientMode(items);
    } else {
      try {
        payload = await requestViaServer(items);
      } catch {
        payload = await runClientMode(items);
      }
    }

    renderResult(payload);
  } catch (error) {
    results.classList.add('hidden');
    setError(error.message || 'Unexpected error.');
  } finally {
    setLoading(false);
  }
}

async function copyWhisper() {
  if (!bestSellerState) return;

  const itemNames = bestSellerState.items.map((item) => item.name).join(', ');
  const message = `/w ${bestSellerState.username} Hi! I want to buy: ${itemNames}. Total: ${bestSellerState.totalPrice} platinum (VoidTrader)`;

  try {
    await navigator.clipboard.writeText(message);
    copyFeedback.textContent = 'Whisper message copied to clipboard.';
  } catch {
    copyFeedback.textContent = message;
  }
}

findButton.addEventListener('click', findBestSeller);
copyWhisperButton.addEventListener('click', copyWhisper);
