const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Bottleneck = require('bottleneck');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const WFM_API_BASE = 'https://api.warframe.market/v1';
const CACHE_TTL_MS = 5 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const requestLimiter = new Bottleneck({
  reservoir: 3,
  reservoirRefreshAmount: 3,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 3
});

const ordersCache = new Map();

function normalizeItemName(itemName) {
  return itemName
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
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

  return cached.data;
}

function setCache(slug, data) {
  ordersCache.set(slug, {
    timestamp: Date.now(),
    data
  });
}

async function fetchOrders(itemSlug) {
  const cached = getFromCache(itemSlug);
  if (cached) {
    return cached;
  }

  const url = `${WFM_API_BASE}/items/${encodeURIComponent(itemSlug)}/orders`;
  const response = await requestLimiter.schedule(() => axios.get(url, {
    timeout: 10000,
    headers: {
      Accept: 'application/json'
    }
  }));

  const orders = response?.data?.payload?.orders || [];
  setCache(itemSlug, orders);
  return orders;
}

function getOrderPlatform(order) {
  return (order.platform || order.user?.platform || '').toLowerCase();
}

function isOrderOnline(order) {
  return (order.user?.status || '').toLowerCase() === 'ingame';
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
    const slugs = items.map((item) => {
      const slug = normalizeItemName(item);
      slugMap.set(slug, item);
      return slug;
    }).filter(Boolean);

    const fetchResults = await Promise.allSettled(slugs.map((slug) => fetchOrders(slug)));

    const sellers = new Map();
    const unavailableItems = [];

    fetchResults.forEach((result, index) => {
      const slug = slugs[index];
      const displayName = slugMap.get(slug) || slug;

      if (result.status !== 'fulfilled') {
        unavailableItems.push({ item: displayName, reason: 'API request failed' });
        return;
      }

      const sellerOrders = selectBestOrderPerSeller(result.value);
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
      topSellers: rankedSellers.slice(0, 10)
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
