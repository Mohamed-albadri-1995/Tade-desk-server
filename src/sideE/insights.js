const db = require('../db');
const https = require('https');

function generateRuleBasedInsights(model) {
  const { features, globalWinRate } = model;

  // Sort features by importance
  const sorted = Object.entries(features)
    .sort((a, b) => b[1].importancePct - a[1].importancePct)
    .slice(0, 15);

  const insights = [];

  for (const [feat, fd] of sorted) {
    if (!fd.buckets || Object.keys(fd.buckets).length === 0) continue;

    const bucketList = Object.entries(fd.buckets)
      .filter(([, b]) => b.count >= 3)
      .sort((a, b) => b[1].winRate - a[1].winRate);

    if (bucketList.length < 2) continue;

    const best = bucketList[0];
    const worst = bucketList[bucketList.length - 1];

    const bestLift = ((best[1].winRate - globalWinRate) / globalWinRate * 100).toFixed(0);
    const worstLift = ((worst[1].winRate - globalWinRate) / globalWinRate * 100).toFixed(0);

    const label = feat.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim();

    if (Math.abs(best[1].winRate - globalWinRate) > 0.05) {
      insights.push({
        type: bestLift > 0 ? 'BEST' : 'AVOID',
        feature: feat,
        label,
        bucket: best[0],
        winRate: best[1].winRate,
        count: best[1].count,
        lift: bestLift,
        text: `${label} = ${best[0]}: ${(best[1].winRate * 100).toFixed(1)}% win rate (${bestLift > 0 ? '+' : ''}${bestLift}% vs baseline)`,
      });
    }
    if (Math.abs(worst[1].winRate - globalWinRate) > 0.05) {
      insights.push({
        type: worstLift < 0 ? 'AVOID' : 'BEST',
        feature: feat,
        label,
        bucket: worst[0],
        winRate: worst[1].winRate,
        count: worst[1].count,
        lift: worstLift,
        text: `${label} = ${worst[0]}: ${(worst[1].winRate * 100).toFixed(1)}% win rate (${worstLift > 0 ? '+' : ''}${worstLift}% vs baseline)`,
      });
    }
  }

  return insights.slice(0, 10);
}

function callAI(prompt, apiKey, model) {
  const isAnthropic = apiKey.startsWith('sk-ant-');

  if (isAnthropic) {
    // Anthropic API
    const body = JSON.stringify({
      model: model || 'claude-haiku-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed.content?.[0]?.text || '');
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
  } else {
    // OpenRouter API
    const body = JSON.stringify({
      model: model || 'anthropic/claude-haiku-4-5',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
    });
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'HTTP-Referer': 'https://github.com/Mohamed-albadri-1995/Tade-desk-server',
        },
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed.choices?.[0]?.message?.content || '');
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
  }
}

async function generateInsights(model, forceAI = false) {
  const getSetting = k => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return r ? r.value : '';
  };

  const ruleInsights = generateRuleBasedInsights(model);
  const aiKey = getSetting('aiApiKey');
  const aiModel = getSetting('aiModel') || 'gpt-4o-mini';

  let aiText = null;
  if (aiKey && (forceAI || !model.insights?.aiText)) {
    try {
      const top5 = ruleInsights.slice(0, 5).map(i => `- ${i.text}`).join('\n');
      const gwr = ((model.backtest?.globalWinRate || globalWinRate) * 100).toFixed(1);
      const prompt = `You are analyzing a stock momentum scanning system. The global win rate is ${gwr}%. The top 5 statistical insights from a ${model.config.trainingWindow}-day backtest are:\n${top5}\n\nIn 3-5 bullet points, summarize the key trading conditions this model favors and what traders should watch for. Be specific and actionable. Start directly with the bullets.`;
      aiText = await callAI(prompt, aiKey, aiModel);
    } catch (err) {
      console.warn('[Insights] AI failed:', err.message);
    }
  }

  const insights = { ruleInsights, aiText, generatedAt: Date.now() };

  db.prepare('UPDATE analysis_model SET insights = ? WHERE id = 1').run(JSON.stringify(insights));

  return insights;
}

module.exports = { generateInsights };
