const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Bottleneck = require('bottleneck');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const WFM_API_BASE = process.env.WFM_API_BASE || 'https://api.warframe.market/v1';
const CACHE_TTL_MS = 5 * 60 * 1000;
const ITEM_INDEX_TTL_MS = 60 * 60 * 1000;
const MAX_RETRIES = 2;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const requestLimiter = new Bottleneck({
  reservoir: 3,
  reservoirRefreshAmount: 3,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 3,
  minTime: 340
});

const http = axios.create({
  timeout: 12000,
  headers: {
    Accept: 'application/json',
    'User-Agent': 'VoidTrader/1.1 (+https://warframe.market)'
  }
});

const ordersCache = new Map();
let itemIndexCache = {
  timestamp: 0,
  byNormalizedName: new Map()
};

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

function parseItems(inputItems) {
  const list = Array.isArray(inputItems)
    ? inputItems
    : String(inputItems || '').split('\n');

  return [...new Set(
    list
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

function getFromCache(slug) {
  const cached = ordersCache.get(slug);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    ordersCache.delete(slug);
    return null;
  }

  return cached;
}

function setCache(slug, data) {
  ordersCache.set(slug, {
    timestamp: Date.now(),
    data
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await requestLimiter.schedule(() => http.get(url));
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      const shouldRetry = !status || status >= 500 || status === 429;

      if (!shouldRetry || attempt === MAX_RETRIES) {
        break;
      }

      const backoff = 250 * (2 ** attempt);
      await delay(backoff);
    }
  }

  throw lastError;
}

async function getItemIndex() {
  const age = Date.now() - itemIndexCache.timestamp;
  if (age < ITEM_INDEX_TTL_MS && itemIndexCache.byNormalizedName.size > 0) {
    return itemIndexCache.byNormalizedName;
  }

  const url = `${WFM_API_BASE}/items`;
  const data = await requestJson(url);
  const items = data?.payload?.items || [];

  const byNormalizedName = new Map();
  for (const item of items) {
    const displayName = item.item_name || item.en?.item_name || item.url_name;
    const slug = item.url_name;
    if (!displayName || !slug) {
      continue;
    }

    byNormalizedName.set(normalizeItemName(displayName), slug);
    byNormalizedName.set(normalizeItemName(slug), slug);
  }

  itemIndexCache = {
    timestamp: Date.now(),
    byNormalizedName
  };

  return byNormalizedName;
}

async function resolveSlug(inputItem) {
  const normalized = normalizeItemName(inputItem);
  if (!normalized) {
    return null;
  }

  try {
    const index = await getItemIndex();
    return index.get(normalized) || normalized;
  } catch {
    return normalized;
  }
}

async function fetchOrders(itemSlug) {
  const cached = getFromCache(itemSlug);
  if (cached) {
    return {
      orders: cached.data,
      fromCache: true
    };
  }

  const url = `${WFM_API_BASE}/items/${encodeURIComponent(itemSlug)}/orders`;
  const data = await requestJson(url);
  const orders = data?.payload?.orders || [];

  setCache(itemSlug, orders);
  return {
    orders,
    fromCache: false
  };
}

function getOrderPlatform(order) {
  return (order.platform || order.user?.platform || '').toLowerCase();
}

function isOrderOnline(order) {
  const status = (order.user?.status || '').toLowerCase();
  return status === 'ingame' || status === 'online';
}

function selectBestOrderPerSeller(orders) {
  const perSeller = new Map();

  for (const order of orders) {
    if (!order || order.order_type !== 'sell' || order.visible === false) {
      continue;
    }

    const platform = getOrderPlatform(order);
    if (platform && platform !== 'pc') {
      continue;
    }

    const username = order.user?.ingame_name || order.user?.id;
    if (!username) {
      continue;
    }

    const platinum = Number(order.platinum);
    if (!Number.isFinite(platinum) || platinum < 0) {
      continue;
    }

    const existing = perSeller.get(username);
    const candidate = {
      username,
      platinum,
      online: isOrderOnline(order)
    };

    if (!existing) {
      perSeller.set(username, candidate);
      continue;
    }

    if (candidate.platinum < existing.platinum) {
      perSeller.set(username, candidate);
      continue;
    }

    if (candidate.platinum === existing.platinum && candidate.online && !existing.online) {
      perSeller.set(username, candidate);
    }
  }

  return perSeller;
}

function compareSellers(a, b) {
  if (b.items.length !== a.items.length) {
    return b.items.length - a.items.length;
  }

  if (a.totalPrice !== b.totalPrice) {
    return a.totalPrice - b.totalPrice;
  }

  if (a.online !== b.online) {
    return a.online ? -1 : 1;
  }

  return a.username.localeCompare(b.username);
}

app.post('/api/best-seller', async (req, res) => {
  try {
    const items = parseItems(req.body?.items);

    if (!items.length) {
      return res.status(400).json({ error: 'Please provide at least one item.' });
    }

    const slugMap = new Map();
    await Promise.all(items.map(async (item) => {
      const slug = await resolveSlug(item);
      if (slug) {
        slugMap.set(slug, item);
      }
    }));

    const slugs = [...new Set(slugMap.keys())];

    if (!slugs.length) {
      return res.status(400).json({ error: 'No valid items were detected.' });
    }

    const fetchResults = await Promise.allSettled(slugs.map((slug) => fetchOrders(slug)));

    const sellers = new Map();
    const unavailableItems = [];
    let cacheHits = 0;

    fetchResults.forEach((result, index) => {
      const slug = slugs[index];
      const displayName = slugMap.get(slug) || slug;

      if (result.status !== 'fulfilled') {
        unavailableItems.push({ item: displayName, reason: 'API request failed' });
        return;
      }

      if (result.value.fromCache) {
        cacheHits += 1;
      }

      const sellerOrders = selectBestOrderPerSeller(result.value.orders);
      if (!sellerOrders.size) {
        unavailableItems.push({ item: displayName, reason: 'No sell orders found' });
        return;
      }

      for (const sellerOrder of sellerOrders.values()) {
        const existingSeller = sellers.get(sellerOrder.username) || {
          username: sellerOrder.username,
          online: false,
          totalPrice: 0,
          items: []
        };

        existingSeller.online = existingSeller.online || sellerOrder.online;
        existingSeller.totalPrice += sellerOrder.platinum;
        existingSeller.items.push({
          name: displayName,
          slug,
          platinum: sellerOrder.platinum
        });

        sellers.set(sellerOrder.username, existingSeller);
      }
    });

    const rankedSellers = [...sellers.values()]
      .map((seller) => ({
        ...seller,
        totalPrice: Number(seller.totalPrice.toFixed(2)),
        itemCount: seller.items.length
      }))
      .sort(compareSellers);

    if (!rankedSellers.length) {
      return res.status(404).json({
        error: 'No sellers found for provided items.',
        unavailableItems
      });
    }

    const bestSeller = rankedSellers[0];

    return res.json({
      requestedItemCount: items.length,
      resolvedItemCount: slugs.length,
      unavailableItems,
      bestSeller,
      topSellers: rankedSellers.slice(0, 10),
      meta: {
        cacheHits,
        cacheMisses: slugs.length - cacheHits,
        cacheTtlSeconds: CACHE_TTL_MS / 1000
      }
    });
  } catch (error) {
    console.error('best-seller error:', error.message);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`VoidTrader server listening on port ${PORT}`);
});
