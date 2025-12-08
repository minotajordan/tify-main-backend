const metrics = {
  total: 0,
  totalResponseTimeMs: 0,
  statusCodes: new Map(),
  endpointCounts: new Map(),
  recentRequests: [],
  perSecond: new Map(), // key: epochSecond -> count
};

function recordRequest(method, endpoint, statusCode, responseTimeMs, timestampMs) {
  metrics.total += 1;
  metrics.totalResponseTimeMs += responseTimeMs;
  const sc = String(statusCode);
  metrics.statusCodes.set(sc, (metrics.statusCodes.get(sc) || 0) + 1);
  metrics.endpointCounts.set(endpoint, (metrics.endpointCounts.get(endpoint) || 0) + 1);

  metrics.recentRequests.unshift({
    method,
    endpoint,
    statusCode,
    responseTime: responseTimeMs,
    timestamp: timestampMs,
  });
  if (metrics.recentRequests.length > 200) metrics.recentRequests.pop();

  const sec = Math.floor(timestampMs / 1000);
  metrics.perSecond.set(sec, (metrics.perSecond.get(sec) || 0) + 1);
  // keep only last ~5 minutes of buckets
  const cutoff = sec - 300;
  for (const k of metrics.perSecond.keys()) {
    if (k < cutoff) metrics.perSecond.delete(k);
  }
}

function getSnapshot() {
  const nowSec = Math.floor(Date.now() / 1000);
  const series = [];
  for (let s = nowSec - 59; s <= nowSec; s++) {
    series.push({ second: s, count: metrics.perSecond.get(s) || 0 });
  }
  const lastSecCount = metrics.perSecond.get(nowSec) || 0;
  const statusCodesObj = {};
  for (const [k, v] of metrics.statusCodes.entries()) statusCodesObj[k] = v;
  const topEndpoints = Array.from(metrics.endpointCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([endpoint, count]) => ({ endpoint, count }));
  const avgResponseTime = metrics.total === 0 ? 0 : Math.round(metrics.totalResponseTimeMs / metrics.total);
  return {
    timestamp: Date.now(),
    requestsPerSecond: lastSecCount,
    recentRequests: metrics.recentRequests.slice(0, 50),
    stats: {
      total: metrics.total,
      avgResponseTime,
      statusCodes: statusCodesObj,
    },
    topEndpoints,
    series, // last 60s counts
  };
}

function resetMetrics() {
  metrics.total = 0;
  metrics.totalResponseTimeMs = 0;
  metrics.statusCodes.clear();
  metrics.endpointCounts.clear();
  metrics.recentRequests = [];
  metrics.perSecond.clear();
}

function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  const startMs = Date.now();
  res.on('finish', () => {
    try {
      const end = process.hrtime.bigint();
      const diffMs = Number(end - start) / 1e6;
      const method = req.method;
      const endpoint = req.originalUrl || req.url;
      const statusCode = res.statusCode;
      recordRequest(method, endpoint, statusCode, Math.round(diffMs), startMs);
    } catch {}
  });
  next();
}

module.exports = {
  metrics,
  getSnapshot,
  resetMetrics,
  metricsMiddleware,
};