// LCA Studio Bot — Telegram + Gemini + Supabase
// github: lca-bot | autor: at.daniel@gmail.com

const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL   || 'https://amkuqijbwjspxajiguxz.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const ALLOWED_USER   = (process.env.ALLOWED_USER  || '').toLowerCase();

// ── HTTP ──────────────────────────────────────────────────────────
function req(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {}
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// ── Telegram ──────────────────────────────────────────────────────
function tgSend(chatId, text) {
  return req(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { chat_id: chatId, text, parse_mode: 'Markdown' });
}
function tgUpdates(offset) {
  return req(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=25`);
}

// ── Supabase ──────────────────────────────────────────────────────
const SB_HEADERS = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation'
});
const sbGet  = (t, q='') => req(`${SUPABASE_URL}/rest/v1/${t}?${q}`, { headers: SB_HEADERS() });
const sbPost = (t, b)    => req(`${SUPABASE_URL}/rest/v1/${t}`, { method:'POST', headers: SB_HEADERS() }, b);
const sbPatch= (t, q, b) => req(`${SUPABASE_URL}/rest/v1/${t}?${q}`, { method:'PATCH', headers: SB_HEADERS() }, b);

// ── Gemini ────────────────────────────────────────────────────────
async function ai(prompt) {
  const r = await req(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { contents: [{ parts: [{ text: prompt }] }] }
  );
  try { return r.candidates[0].content.parts[0].text.trim(); } catch { return null; }
}

// ── Dados do sistema ──────────────────────────────────────────────
async function getDados() {
  const [alunos, custos] = await Promise.all([
    sbGet('alunos', 'select=id,nome,ativo,tipo_plano,vezes_semana,forma_pagamento,dia_vencimento,professora,pagamentos,pagamentos_pendentes&ativo=eq.SIM'),
    sbGet('custos', 'select=*&order=id.desc&limit=50')
  ]);
  return { alunos: Array.isArray(alunos) ? alunos : [], custos: Array.isArray(custos) ? custos : [] };
}

// ── Interpretar comando via IA ────────────────────────────────────
async function interpretar(texto, dados) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  const mes  = new Date().toISOString().slice(0, 7);
  const resumoAlunos = dados.alunos.map(a => `${a.id}|${a.nome}|${a.tipo_plano}|${a.vezes_semana}x`).join('\n');

  const prompt = `Você é o assistente do LCA Studio de Pilates (Rio de Janeiro).
Hoje: ${hoje} | Mês atual: ${mes}

ALUNOS ATIVOS:
${resumoAlunos}

COMANDO DO GESTOR: "${texto}"

Retorne APENAS um JSON válido, sem markdown:
{
  "acao": "consulta_inadimplentes" | "consulta_financeiro" | "lancar_custo" | "lancar_aula" | "confirmar_pagamento" | "calcular_rescisao" | "saudacao" | "desconhecido",
  "params": {
    "aluno_id": número ou null,
    "aluno_nome": string ou null,
    "valor": número ou null,
    "mes": "YYYY-MM" ou null,
    "categoria": string ou null,
    "descricao": string ou null,
    "professora": string ou null,
    "horas": número ou null,
    "meses_utilizados": número ou null,
    "data": "YYYY-MM-DD" ou null
  },
  "confirmacao": "frase resumindo a ação a executar (máx 1 linha)"
}`;

  const raw = await ai(prompt);
  if (!raw) return null;
  try {
    return JSON.parse(raw.replace(/```json\n?/g,'').replace(/```/g,''));
  } catch {
    return null;
  }
}

// ── Executar ação ─────────────────────────────────────────────────
async function executar(cmd, dados) {
  const p   = cmd.params;
  const mes = p.mes || new Date().toISOString().slice(0, 7);
  const brl = v => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

  if (cmd.acao === 'consulta_inadimplentes') {
    const list = dados.alunos.filter(a => {
      const pago    = (a.pagamentos         || {})[mes] || 0;
      const aguard  = (a.pagamentos_pendentes|| {})[mes] || 0;
      return pago === 0 && aguard === 0;
    });
    if (!list.length) return `✅ Todos pagaram em ${mes}!`;
    return `⚠️ *Inadimplentes — ${mes}*\n\n` + list.map(a => `• ${a.nome} (${a.tipo_plano})`).join('\n');
  }

  if (cmd.acao === 'consulta_financeiro') {
    const total = dados.alunos.reduce((s, a) => s + ((a.pagamentos || {})[mes] || 0), 0);
    const pagos = dados.alunos.filter(a => ((a.pagamentos || {})[mes] || 0) > 0).length;
    const custosMes = dados.custos.filter(c => c.mes === mes);
    const totalCustos = custosMes.reduce((s, c) => s + (c.valor || 0), 0);
    return `📊 *Resumo ${mes}*\n\n💰 Receita: *${brl(total)}* (${pagos} pagamentos)\n🔴 Custos: *${brl(totalCustos)}*\n📈 Resultado: *${brl(total - totalCustos)}*`;
  }

  if (cmd.acao === 'lancar_custo') {
    if (!p.valor || !p.categoria) return '❌ Informe o valor e a categoria do custo.';
    await sbPost('custos', {
      descricao: p.descricao || p.categoria,
      valor: p.valor,
      categoria: p.categoria,
      mes
    });
    return `✅ Custo lançado!\n*${p.descricao || p.categoria}* — ${brl(p.valor)} — ${mes}`;
  }

  if (cmd.acao === 'lancar_aula') {
    if (!p.horas) return '❌ Informe o número de horas.';
    const profId = (p.professora || '').toLowerCase().includes('kelly') ? 'kelly' :
                   (p.professora || '').toLowerCase().includes('monica') ? 'monica' : 'leda';
    const data = p.data || new Date().toISOString().slice(0, 10);
    await sbPost('aulas', {
      prof_id: profId, mes,
      data, data_fmt: data.split('-').reverse().join('/'),
      horas: p.horas, vh: p.horas,
      desc_aula: `Lançado via bot — ${p.horas}h`
    });
    return `✅ Aula lançada!\n*${p.professora || profId}* — ${p.horas}h — ${data}`;
  }

  if (cmd.acao === 'confirmar_pagamento') {
    const aluno = dados.alunos.find(a =>
      (p.aluno_id && a.id === p.aluno_id) ||
      (p.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase()))
    );
    if (!aluno) return `❌ Aluno não encontrado: "${p.aluno_nome}".`;
    if (!p.valor)  return `❌ Informe o valor do pagamento.`;
    const pags = { ...(aluno.pagamentos || {}) };
    pags[mes] = p.valor;
    await sbPatch('alunos', `id=eq.${aluno.id}`, { pagamentos: pags });
    return `✅ Pagamento confirmado!\n*${aluno.nome}* — ${brl(p.valor)} — ${mes}`;
  }

  if (cmd.acao === 'calcular_rescisao') {
    const aluno = dados.alunos.find(a =>
      (p.aluno_id && a.id === p.aluno_id) ||
      (p.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase()))
    );
    if (!aluno) return `❌ Aluno não encontrado: "${p.aluno_nome}".`;
    const DUR = { mensal: 1, trimestral: 3, semestral: 6 };
    const dur = DUR[aluno.tipo_plano] || 1;
    const pags = Object.entries(aluno.pagamentos || {}).filter(e => e[1] > 0)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const totalPago = pags.reduce((s, e) => s + e[1], 0);
    const ultV      = pags.length ? pags[pags.length - 1][1] : 329;
    const mUsados   = p.meses_utilizados || 1;
    const mRestantes= dur - mUsados;
    const deveria   = ultV * mUsados;
    const diferenca = deveria - totalPago;
    const multa     = ultV * 0.2 * mRestantes;
    const saldo     = diferenca + multa;
    const brl2 = v => 'R$ ' + Math.abs(v).toFixed(2).replace('.', ',');
    return (
      `📋 *Rescisão — ${aluno.nome}*\n\n` +
      `Plano: ${aluno.tipo_plano} (${dur} meses)\n` +
      `Meses utilizados: ${mUsados} | Restantes: ${mRestantes}\n\n` +
      `Deveria pagar: ${brl2(deveria)}\n` +
      `Total já pago: ${brl2(totalPago)}\n` +
      `Diferença de plano: ${brl2(diferenca)}\n` +
      `Multa 20% × ${mRestantes} meses: ${brl2(multa)}\n\n` +
      `*Saldo a pagar: ${brl2(saldo)}*\n\n` +
      `_Para confirmar e lançar no sistema, responda:_ *sim*`
    );
  }

  if (cmd.acao === 'saudacao') {
    return (
      `👋 *LCA Studio Bot*\n\n` +
      `Olá Daniel! Estou pronto. Exemplos:\n\n` +
      `• _"quem não pagou junho?"_\n` +
      `• _"custo aluguel 3500 junho"_\n` +
      `• _"kelly deu 2 aulas hoje"_\n` +
      `• _"Ana Lima pagou 329 boleto"_\n` +
      `• _"resumo financeiro de maio"_\n` +
      `• _"Mara quer rescindir, plano semestral, pagou 2 meses"_`
    );
  }

  return `🤔 Não entendi. Tente reformular ou veja exemplos enviando: *oi*`;
}

// ── Confirmações pendentes ────────────────────────────────────────
const pendente = {};

// ── Processar mensagem ────────────────────────────────────────────
async function processar(msg) {
  const chatId   = msg.chat.id;
  const username = (msg.from.username || '').toLowerCase();
  const texto    = (msg.text || '').trim();

  // Segurança: só Daniel pode usar
  if (ALLOWED_USER && username !== ALLOWED_USER) {
    return tgSend(chatId, '🔒 Acesso não autorizado.');
  }

  // Resposta a confirmação pendente (rescisão)
  if (pendente[chatId]) {
    const { cmd, dados } = pendente[chatId];
    delete pendente[chatId];
    if (['sim', 'confirmar', 'ok', 's'].includes(texto.toLowerCase())) {
      const result = await executar(cmd, dados);
      return tgSend(chatId, result);
    }
    return tgSend(chatId, '❌ Cancelado.');
  }

  await tgSend(chatId, '⏳ Processando...');
  const dados = await getDados();
  const cmd   = await interpretar(texto, dados);

  if (!cmd) {
    return tgSend(chatId, '❌ Erro ao interpretar. Tente novamente.');
  }

  // Rescisão: confirmar antes de salvar
  if (cmd.acao === 'calcular_rescisao') {
    const preview = await executar(cmd, dados);
    pendente[chatId] = { cmd, dados };
    return tgSend(chatId, preview);
  }

  // Pagamento e custo: confirmar antes
  if (['confirmar_pagamento', 'lancar_custo', 'lancar_aula'].includes(cmd.acao)) {
    pendente[chatId] = { cmd, dados };
    return tgSend(chatId, `⚠️ *Confirmar?*\n\n${cmd.confirmacao}\n\nResponda *sim* para confirmar.`);
  }

  // Consultas: responder direto
  const result = await executar(cmd, dados);
  return tgSend(chatId, result);
}

// ── Loop principal ────────────────────────────────────────────────
async function main() {
  console.log('LCA Bot iniciado ✓');
  let offset = 0;
  while (true) {
    try {
      const res = await tgUpdates(offset);
      if (res.result && res.result.length) {
        for (const upd of res.result) {
          offset = upd.update_id + 1;
          if (upd.message && upd.message.text) {
            processar(upd.message).catch(e => console.error('Erro:', e.message));
          }
        }
      }
    } catch (e) {
      console.error('Loop error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main();
