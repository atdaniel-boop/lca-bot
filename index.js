// LCA Studio Bot — Telegram + Gemini + Supabase
// Versão 3.2 — professoras lidas da tabela (retirada/percentual/valor-hora reais), correção do vh no lançamento de aula

const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://amkuqijbwjspxajiguxz.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const ALLOWED_USER   = (process.env.ALLOWED_USER || '').toLowerCase();

// ── HTTP ──────────────────────────────────────────────────────────
function req(url, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: headers || {},
      timeout: timeoutMs || 25000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('Request timeout')); });
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// ── Telegram ──────────────────────────────────────────────────────
function tgSend(chatId, text) {
  return req(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    'POST', { 'Content-Type': 'application/json' },
    { chat_id: chatId, text, parse_mode: 'Markdown' });
}
function tgUpdates(offset) {
  return req(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=25`, 'GET', {}, null, 35000);
}

// ── Supabase ──────────────────────────────────────────────────────
function sbHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json', Prefer: 'return=representation' };
}
const sbGet   = (t, q) => req(SUPABASE_URL+'/rest/v1/'+t+'?'+(q||''), 'GET', sbHeaders(), null);
const sbPost  = (t, b) => req(SUPABASE_URL+'/rest/v1/'+t, 'POST', sbHeaders(), b);
const sbPatch = (t, q, b) => req(SUPABASE_URL+'/rest/v1/'+t+'?'+q, 'PATCH', sbHeaders(), b);
const sbDelete= (t, q) => req(SUPABASE_URL+'/rest/v1/'+t+'?'+q, 'DELETE', sbHeaders(), null);

// ── Gemini ────────────────────────────────────────────────────────
function aiWithTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout '+ms+'ms')), ms))
  ]);
}

async function ai(prompt) {
  const models = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
  for (const model of models) {
    try {
      const r = await aiWithTimeout(req(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        'POST', { 'Content-Type': 'application/json' },
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 800 } },
        8000
      ), 9000);
      if (r?.candidates?.[0]?.content) return r.candidates[0].content.parts[0].text.trim();
      if (r?.error?.code === 503 || r?.error?.code === 429) { console.log(model+' indisponível ('+r.error.code+')'); continue; }
      if (r?.error) { console.error('Gemini erro em '+model+':', r.error.code, r.error.message?.slice(0,60)); continue; }
      console.log(model+' sem candidatos — resposta:', JSON.stringify(r).slice(0,80));
    } catch(e) {
      console.error('Gemini '+model+':', e.message);
      if (e.message.includes('timeout')) continue;
    }
  }
  return null;
}

async function aiJSON(prompt) {
  const raw = await ai(prompt + '\n\nRetorne APENAS JSON válido, sem markdown, sem explicação, sem texto antes ou depois.');
  if (!raw) return null;
  try {
    // Extrai apenas o bloco JSON entre o primeiro { e o último }
    const clean = raw.replace(/```json\n?/g,'').replace(/```/g,'').trim();
    const start = clean.indexOf('{');
    const end   = clean.lastIndexOf('}');
    if (start < 0 || end < 0) throw new Error('No JSON object found');
    return JSON.parse(clean.slice(start, end+1));
  } catch(e) {
    console.error('JSON parse erro:', e.message, '| raw:', raw.slice(0,120));
    return null;
  }
}

// ── Dados ─────────────────────────────────────────────────────────
async function getDados() {
  const [ra, rc, rk] = await Promise.all([
    sbGet('alunos', 'select=id,nome,ativo,tipo_plano,vezes_semana,forma_pagamento,dia_vencimento,professora,prof_secundaria,aulas_prof,pagamentos,pagamentos_pendentes,pagamentos_rescisao,data_matricula,historico_alteracoes'),
    sbGet('custos', 'select=*&order=id.desc'),
    sbGet('aulas',  'select=*&order=id.desc')
  ]);
  // Professoras: query separada com fallback silencioso (evita travar o bot se schema cache estiver desatualizado)
  let professoras = [];
  try {
    const rp = await sbGet('professoras', 'select=id,nome,tipo,percentual,valor_hora,retirada,cor');
    if (Array.isArray(rp) && rp.length) professoras = rp;
  } catch(e) {
    console.error('getDados professoras erro (usando fallback):', e.message);
  }
  // Fallback para os valores históricos caso a tabela esteja vazia ou inacessível
  if (!professoras.length) {
    professoras = [
      {id:'leda',   nome:'Leda',   tipo:'proprietaria', percentual:0,  valor_hora:0,  retirada:6000},
      {id:'monica', nome:'Monica', tipo:'percentual',   percentual:40, valor_hora:0,  retirada:0},
      {id:'kelly',  nome:'Kelly',  tipo:'hora',         percentual:0,  valor_hora:35, retirada:0}
    ];
  }
  // Buscar agenda/checkins
  let changes = null;
  try {
    const rch = await sbGet('changes', 'select=data&order=id.desc&limit=1');
    if (Array.isArray(rch) && rch[0]?.data) {
      changes = typeof rch[0].data === 'string' ? JSON.parse(rch[0].data) : rch[0].data;
    }
  } catch(e) {}
  return {
    alunos:  Array.isArray(ra) ? ra : [],
    custos:  Array.isArray(rc) ? rc : [],
    aulas:   Array.isArray(rk) ? rk : [],
    professoras: professoras,
    changes: changes
  };
}

async function saveChanges(ch) {
  try {
    await req(SUPABASE_URL+'/rest/v1/changes', 'POST',
      { ...sbHeaders(), Prefer: 'resolution=merge-duplicates' }, { id: 1, data: ch });
  } catch(e) { console.error('saveChanges erro:', e.message); }
}

function brl(v) { return 'R$ ' + Math.abs(Number(v)||0).toFixed(2).replace('.', ','); }

// ── Contexto resumido para a IA ───────────────────────────────────
function buildContexto(dados, mes) {
  const ativos = dados.alunos.filter(a => a.ativo === 'SIM');
  const inativos = dados.alunos.filter(a => a.ativo !== 'SIM');

  // Pagamentos do mês
  const pagMes = dados.alunos.map(a => {
    const pags = typeof a.pagamentos === 'string' ? JSON.parse(a.pagamentos||'{}') : (a.pagamentos||{});
    const v = pags[mes] || 0;
    return { id: a.id, nome: a.nome, ativo: a.ativo, plano: a.tipo_plano, vezes: a.vezes_semana,
             professora: a.professora, pagou: v > 0, valor: v };
  });

  // Receita líquida do mês = pagamentos - saldos de rescisão (igual ao recMes do web)
  const totalRescisaoMes = dados.alunos.reduce((s, a) => {
    const pr = typeof a.pagamentos_rescisao === 'string' ? JSON.parse(a.pagamentos_rescisao||'{}') : (a.pagamentos_rescisao||{});
    return s + (pr[mes] || 0);
  }, 0);
  const receitaMes = pagMes.reduce((s, a) => s + a.valor, 0) - totalRescisaoMes;
  const inadimplentes = ativos.filter(a => {
    const pag = pagMes.find(p => p.id === a.id);
    return !pag || !pag.pagou;
  });

  // Custos do mês
  const custosMes = dados.custos.filter(c => c.mes === mes);
  const totalCustos = custosMes.reduce((s, c) => s + (c.valor||0), 0);

  // Professoras — valores reais da tabela (fonte única de verdade)
  const profs = dados.professoras || [];
  const profMonica = profs.find(p => p.id === 'monica') || profs.find(p => p.tipo === 'percentual');
  const profKelly  = profs.find(p => p.id === 'kelly')  || profs.find(p => p.tipo === 'hora');
  const profLeda   = profs.find(p => p.id === 'leda')   || profs.find(p => p.tipo === 'proprietaria');
  const pctMonica  = profMonica && profMonica.percentual > 0 ? profMonica.percentual/100 : 0.4;
  const vhKelly    = profKelly && profKelly.valor_hora > 0 ? profKelly.valor_hora : 35;
  const retLeda    = profLeda && profLeda.retirada > 0 ? profLeda.retirada : 6000;

  let totalMonica = 0;
  ativos.forEach(a => {
    const pags = typeof a.pagamentos === 'string' ? JSON.parse(a.pagamentos||'{}') : (a.pagamentos||{});
    const v = pags[mes] || 0;
    if (!v) return;
    if (a.professora === 'monica') totalMonica += v * pctMonica;
    else if (a.professora === 'ambas' && a.prof_secundaria === 'monica') {
      totalMonica += v * pctMonica * ((a.aulas_prof||1)/(a.vezes_semana||2));
    }
  });
  const aulasKelly = dados.aulas.filter(k => k.prof_id === 'kelly' && k.mes === mes);
  const totalKelly = aulasKelly.reduce((s, k) => s + (k.horas||k.vh||0)*vhKelly, 0);
  const totalLeda = retLeda;
  const totalProf = totalLeda + totalMonica + totalKelly;
  const resultado = receitaMes - totalProf - totalCustos;

  // Agenda/faltas
  const checkins = (dados.changes?.checkins) || {};
  const faltasPorAluno = {};
  Object.entries(checkins).forEach(([ck, ci]) => {
    if (ck.slice(0,7) === mes) {
      (ci.falta||[]).forEach(id => { faltasPorAluno[id] = (faltasPorAluno[id]||0)+1; });
    }
  });

  // Calcular planos vencendo (próximos 30 dias)
  const hojeTs = new Date(); hojeTs.setHours(0,0,0,0);
  const DUR = { mensal:1, trimestral:3, semestral:6 };
  const planosVencendo = ativos
    .filter(a => a.tipo_plano === 'trimestral' || a.tipo_plano === 'semestral')
    .map(a => {
      const pend = typeof a.pagamentos_pendentes==='string'?JSON.parse(a.pagamentos_pendentes||'{}'):(a.pagamentos_pendentes||{});
      const pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
      // Todos os meses com valor (pago ou pendente)
      const todosMeses = [...new Set([
        ...Object.keys(pend).filter(k=>(pend[k]||0)>0),
        ...Object.keys(pags).filter(k=>(pags[k]||0)>0)
      ])].sort();
      if (!todosMeses.length) return null;
      // Último mês do plano atual
      const lastMes = todosMeses[todosMeses.length-1];
      const lp = lastMes.split('-');
      const diaVenc = parseInt(a.dia_vencimento||10);
      // Vencimento = dia de vencimento no mês seguinte ao último mês pago
      const venc = new Date(parseInt(lp[0]), parseInt(lp[1]), diaVenc);
      const dias = Math.round((venc-hojeTs)/86400000);
      return { nome: a.nome, plano: a.tipo_plano, dias,
        dataVenc: venc.toLocaleDateString('pt-BR'),
        diaVenc: String(venc.getDate()).padStart(2,'0'),
        mesVenc: String(venc.getMonth()+1).padStart(2,'0'),
        ultimoMes: lastMes };
    }).filter(p => p && p.dias >= -5 && p.dias <= 30)
    .sort((a,b) => a.dias-b.dias);

  console.log('Planos vencendo calculados:', planosVencendo.length, '| Trim/Sem ativos:', ativos.filter(a=>a.tipo_plano==='trimestral'||a.tipo_plano==='semestral').length);
  dados._planosVencendo = planosVencendo; // cache

  return {
    hoje: new Date().toLocaleDateString('pt-BR'),
    mes,
    estudio: { totalAlunos: dados.alunos.length, ativos: ativos.length, inativos: inativos.length },
    financeiro: { receita: receitaMes, professoras: totalProf, custos: totalCustos, resultado,
      detalheProfessoras: { leda: totalLeda, monica: totalMonica, kelly: totalKelly },
      paramProf: { retLeda: retLeda, pctMonica: pctMonica, vhKelly: vhKelly } },
    inadimplentes: inadimplentes.map(a => ({ id: a.id, nome: a.nome, plano: a.tipo_plano })),
    custosMes: custosMes.map(c => ({ id: c.id, desc: c.descricao, valor: c.valor })),
    aulasKelly: aulasKelly.map(k => ({ id: k.id, horas: k.horas||k.vh, data: k.data_fmt||k.data })),
    faltasFrequentes: Object.entries(faltasPorAluno)
      .filter(([,n]) => n >= 2)
      .map(([id, n]) => { const a = dados.alunos.find(x => x.id === parseInt(id)); return a ? a.nome+' ('+n+' faltas)' : null; })
      .filter(Boolean),
    planosVencendo: planosVencendo,
    listaAlunos: dados.alunos.map(a => ({ id: a.id, nome: a.nome, ativo: a.ativo,
      plano: a.tipo_plano, vezes: a.vezes_semana, prof: a.professora })),
    todosOsCustos: dados.custos.slice(0,20).map(c => ({ id: c.id, desc: c.descricao, valor: c.valor, mes: c.mes }))
  };
}

// ── Classificar intenção ──────────────────────────────────────────
// Intenções que alteram dados (precisam de execução estruturada)
const INTENCOES_ACAO = ['lancar_custo','lancar_aula','confirmar_pagamento','calcular_rescisao',
  'remover_custo','remover_custo_id','desfazer_pagamento','desfazer_aula','checkin','desfazer_checkin'];

// Chamada unificada: classifica E responde em uma só requisição
async function processarComIA(texto, dados, mes) {
  const ctx = buildContexto(dados, mes);

  // Detectar ações por palavras-chave (sem IA) — economiza cota
  const tL = texto.toLowerCase();
  // Saudação e ajuda — sem IA
  if (['oi','olá','ola','bom dia','boa tarde','boa noite'].some(k => tL.startsWith(k))) {
    return { tipo: 'saudacao' };
  }
  if (['ajuda','help','comando','como usar'].some(k => tL.includes(k))) {
    return { tipo: 'ajuda' };
  }
  // Despedidas e respostas curtas não-acionáveis
  const despedidas = ['obrigado','obrigada','valeu','tchau','até','flw','ok','entendi','certo','legal','perfeito','ótimo','otimo','show','blz','beleza'];
  if (texto.length < 30 && despedidas.some(k => tL.includes(k))) {
    return { tipo: 'consulta', resposta: '😊 Disponível quando precisar!' };
  }

  // UMA chamada ao Gemini — classifica E responde/extrai tudo
  const ultimoValor = {};
  dados.alunos.forEach(function(a) {
    var pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
    var keys = Object.keys(pags).filter(function(k){return pags[k]>0;}).sort();
    if (keys.length) ultimoValor[a.nome] = pags[keys[keys.length-1]];
  });

  const prompt = `Você é o assistente do LCA Studio de Pilates (Rio de Janeiro, ${ctx.hoje}).

DADOS (${mes}):
Ativos: ${ctx.estudio.ativos} | Inadimplentes: ${ctx.inadimplentes.map(function(a){return a.nome;}).join(', ')||'Nenhum'}
Receita: ${brl(ctx.financeiro.receita)} | Professoras: ${brl(ctx.financeiro.professoras)} | Custos: ${brl(ctx.financeiro.custos)} | Resultado: ${brl(ctx.financeiro.resultado)}
Planos vencendo: ${ctx.planosVencendo.length?ctx.planosVencendo.map(function(p){return p.nome+' ('+p.plano+', dia '+p.diaVenc+'/'+p.mesVenc+', '+p.dias+' dias)';}).join(' | '):'Nenhum'}
Custos lancados: ${ctx.custosMes.map(function(c){return c.desc+' '+brl(c.valor);}).join(', ')||'Nenhum'}
Faltas frequentes: ${ctx.faltasFrequentes.join(', ')||'Nenhuma'}
Professoras este mes: Leda ${brl(ctx.financeiro.paramProf.retLeda)} fixo | Monica ${brl(ctx.financeiro.detalheProfessoras.monica)} (${Math.round(ctx.financeiro.paramProf.pctMonica*100)}% alunos dela) | Kelly ${brl(ctx.financeiro.detalheProfessoras.kelly)} (${ctx.aulasKelly.reduce(function(s,k){return s+(k.horas||0);},0)}h x ${brl(ctx.financeiro.paramProf.vhKelly)})
Ultimo pagamento por aluno: ${JSON.stringify(ultimoValor)}

MENSAGEM: "${texto}"

Retorne JSON (sem markdown):
{
  "tipo": "consulta" ou "acao",
  "resposta": "resposta em Markdown se consulta, null se acao",
  "intencao": null se consulta, ou lancar_custo/lancar_aula/confirmar_pagamento/calcular_rescisao/remover_custo/remover_custo_id/desfazer_pagamento/desfazer_aula/checkin/desfazer_checkin,
  "params": {
    "aluno_nome": string ou null,
    "valor": numero (se pagamento sem valor informado, use o ultimo pagamento do aluno acima) ou null,
    "mes": "YYYY-MM" ou null (atual ${mes}),
    "categoria": string ou null,
    "descricao": string ou null,
    "professora": string ou null,
    "horas": numero ou null,
    "meses_utilizados": numero ou null,
    "data": "YYYY-MM-DD" ou null (hoje ${new Date().toISOString().slice(0,10)}),
    "hora": "HH:MM" ou null,
    "status_checkin": presente ou falta ou repos ou null,
    "custo_id": numero ou null
  }
}`;

  const raw = await aiJSON(prompt);
  if (!raw) return { tipo: 'consulta', resposta: null };
  console.log('IA:', raw.tipo, raw.intencao||'consulta');
  return raw;
}

// ── Extrair parâmetros de ação ────────────────────────────────────
async function extrairParams(intencao, texto, dados) {
  const nomes = dados.alunos.map(a => a.id+'|'+a.nome).join('\n');
  const prompt = `Extraia os parâmetros da ação "${intencao}" da mensagem abaixo.

ALUNOS (id|nome):
${nomes}

MENSAGEM: "${texto}"

Retorne JSON com os campos relevantes (use null para campos não mencionados):
{
  "aluno_id": número ou null,
  "aluno_nome": string ou null,
  "valor": número ou null,
  "mes": "YYYY-MM" ou null (mês atual: ${new Date().toISOString().slice(0,7)}),
  "categoria": string ou null,
  "descricao": string ou null,
  "professora": string ou null,
  "horas": número ou null,
  "meses_utilizados": número ou null,
  "data": "YYYY-MM-DD" ou null (hoje: ${new Date().toISOString().slice(0,10)}),
  "hora": "HH:MM" ou null,
  "status_checkin": "presente" | "falta" | "repos" ou null,
  "custo_id": número ou null
}`;

  return await aiJSON(prompt);
}

// ── Executar ação ─────────────────────────────────────────────────
async function executar(intencao, p, dados) {
  const mes = p?.mes || new Date().toISOString().slice(0,7);

  if (intencao === 'lancar_custo') {
    if (!p?.valor || !p?.categoria) return '❌ Informe o valor e a categoria.';
    const desc = (p.descricao||p.categoria) + ' [via Bot Telegram]';
    await sbPost('custos', { descricao: desc, valor: p.valor, categoria: p.categoria, mes });
    const cat = p.descricao||p.categoria;
    return `✅ Custo lançado!\n*${cat}* — ${brl(p.valor)} — ${mes}\n_Para desfazer: "apagar custo ${p.categoria} ${mes}"_`;
  }

  if (intencao === 'lancar_aula') {
    if (!p?.horas) return '❌ Informe o número de horas.';
    const profId = (p.professora||'').toLowerCase().includes('kelly') ? 'kelly' :
                   (p.professora||'').toLowerCase().includes('monica') ? 'monica' : 'kelly';
    const data = p.data || new Date().toISOString().slice(0,10);
    // Valor/hora real da professora (tabela professoras), com fallback 35
    const profObj = (dados.professoras||[]).find(x => x.id === profId);
    const vhReal = profObj && profObj.valor_hora > 0 ? profObj.valor_hora : 35;
    await sbPost('aulas', { prof_id: profId, mes, data, data_fmt: data.split('-').reverse().join('/'),
      horas: p.horas, vh: vhReal, desc_aula: 'Lançado via Bot Telegram — '+p.horas+'h' });
    return `✅ Aula lançada!\n*${profId}* — ${p.horas}h × ${brl(vhReal)} = ${brl(p.horas*vhReal)} — ${data}\n_Para desfazer: "remover aula ${profId}"_`;
  }

  if (intencao === 'confirmar_pagamento') {
    const aluno = dados.alunos.find(a => (p?.aluno_id && a.id===p.aluno_id) ||
      (p?.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase())));
    if (!aluno) return `❌ Aluno não encontrado: "${p?.aluno_nome}".`;
    if (!p?.valor) return '❌ Informe o valor.';
    const pags = Object.assign({}, typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos):aluno.pagamentos||{});
    pags[mes] = p.valor;
    // Remover de pendentes se existir (consistência com o sistema web)
    let pend = typeof aluno.pagamentos_pendentes==='string'?JSON.parse(aluno.pagamentos_pendentes||'{}'):(aluno.pagamentos_pendentes||{});
    pend = Object.assign({}, pend);
    let tinhaPend = false;
    if (pend[mes]) { delete pend[mes]; tinhaPend = true; }
    const hist = (aluno.historico_alteracoes||[]);
    hist.push({ data: new Date().toLocaleDateString('pt-BR'), tipo:'pagamento_bot',
      desc: `Pagamento ${mes} via Bot Telegram: ${brl(p.valor)}` });
    const patchData = { pagamentos: pags, historico_alteracoes: hist };
    if (tinhaPend) patchData.pagamentos_pendentes = pend;
    await sbPatch('alunos', `id=eq.${aluno.id}`, patchData);
    return `✅ Pagamento confirmado!\n*${aluno.nome}* — ${brl(p.valor)} — ${mes}${tinhaPend?'\n_(boleto que estava aguardando foi baixado)_':''}\n_Para desfazer: "desfazer pagamento ${aluno.nome.split(' ')[0]} ${mes}"_`;
  }

  if (intencao === 'desfazer_pagamento') {
    const aluno = dados.alunos.find(a => (p?.aluno_id && a.id===p.aluno_id) ||
      (p?.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase())));
    if (!aluno) return `❌ Aluno não encontrado: "${p?.aluno_nome}".`;
    const pags = Object.assign({}, typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos):aluno.pagamentos||{});
    const mesD = p?.mes || mes;
    if (!pags[mesD]) return `⚠️ ${aluno.nome} não tem pagamento em ${mesD}.`;
    const val = pags[mesD];
    delete pags[mesD];
    await sbPatch('alunos', `id=eq.${aluno.id}`, { pagamentos: pags });
    return `✅ Pagamento desfeito!\n*${aluno.nome}* — ${brl(val)} — ${mesD} removido.`;
  }

  if (intencao === 'remover_custo' || intencao === 'remover_custo_id') {
    let custo;
    if (intencao === 'remover_custo_id' && p?.custo_id) {
      custo = dados.custos.find(c => (c.id||c._id) === p.custo_id);
      if (!custo) return `❌ Custo ID ${p.custo_id} não encontrado.`;
    } else {
      const busca = ((p?.descricao||p?.categoria)||'').toLowerCase();
      const mesR  = p?.mes || mes;
      if (!busca) return '❌ Informe a categoria do custo.';
      const filtro = dados.custos.filter(c => {
        const descOk = (c.descricao||'').toLowerCase().includes(busca);
        const catOk  = (c.categoria||'').toLowerCase().includes(busca);
        return c.mes === mesR && (descOk || catOk);
      });
      if (!filtro.length) {
        const doMes = dados.custos.filter(c => c.mes === mesR);
        const lista = doMes.map(c => `• ${c.descricao||c.categoria} — ${brl(c.valor)}`).join('\n');
        return `❌ Custo "${busca}" não encontrado em ${mesR}.${lista?'\n\nCustos em '+mesR+':\n'+lista:''}`;
      }
      if (filtro.length > 1) {
        return `⚠️ Encontrei ${filtro.length} registros:\n` +
          filtro.map(c => `• ID ${c.id||c._id}: ${c.descricao||c.categoria} — ${brl(c.valor)}`).join('\n') +
          '\n\nMande: "remover custo ID XX"';
      }
      custo = filtro[0];
    }
    await sbDelete('custos', `id=eq.${custo.id||custo._id}`);
    return `✅ Custo removido!\n*${(custo.descricao||custo.categoria).replace(' [via Bot Telegram]','')}* — ${brl(custo.valor)}`;
  }

  if (intencao === 'desfazer_aula') {
    const profId = (p?.professora||'').toLowerCase().includes('kelly') ? 'kelly' :
                   (p?.professora||'').toLowerCase().includes('monica') ? 'monica' : null;
    let filtro = dados.aulas;
    if (profId) filtro = filtro.filter(k => k.prof_id === profId);
    if (p?.mes)  filtro = filtro.filter(k => k.mes === p.mes);
    if (!filtro.length) return `❌ Nenhuma aula encontrada${profId?' para '+profId:''}.`;
    const aula = filtro[0];
    await sbDelete('aulas', `id=eq.${aula.id}`);
    return `✅ Aula removida!\n*${aula.prof_id}* — ${aula.horas||aula.vh}h — ${aula.data_fmt||aula.data}`;
  }

  if (intencao === 'checkin') {
    const aluno = dados.alunos.find(a => (p?.aluno_id && a.id===p.aluno_id) ||
      (p?.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase())));
    if (!aluno) return `❌ Aluno não encontrado: "${p?.aluno_nome}".`;
    const status  = p?.status_checkin || 'presente';
    const dataCi  = p?.data || new Date().toISOString().slice(0,10);
    const horaCi  = p?.hora || '07:00';
    const ckKey   = `${dataCi}-${horaCi}`;
    const ch = (dados.changes?.checkins) ? dados.changes.checkins : {};
    if (!ch[ckKey]) ch[ckKey] = { presente:[], falta:[], repos:[] };
    ch[ckKey].presente = (ch[ckKey].presente||[]).filter(x => x!==aluno.id);
    ch[ckKey].falta    = (ch[ckKey].falta   ||[]).filter(x => x!==aluno.id);
    ch[ckKey].repos    = (ch[ckKey].repos   ||[]).filter(x => x!==aluno.id);
    if (status==='falta') ch[ckKey].falta.push(aluno.id);
    else if (status==='repos') ch[ckKey].repos.push(aluno.id);
    else ch[ckKey].presente.push(aluno.id);
    if (dados.changes) { dados.changes.checkins = ch; await saveChanges(dados.changes); }
    const DIAS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const dow  = new Date(dataCi+'T12:00:00').getDay();
    const LABEL = { presente:'✅ Presente', falta:'❌ Falta', repos:'🔄 Reposição' };
    return `${LABEL[status]} registrado!\n*${aluno.nome}* — ${DIAS[dow]} ${dataCi.slice(8)}/${dataCi.slice(5,7)} ${horaCi}`;
  }

  if (intencao === 'desfazer_checkin') {
    const aluno = dados.alunos.find(a => (p?.aluno_id && a.id===p.aluno_id) ||
      (p?.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase())));
    if (!aluno) return `❌ Aluno não encontrado: "${p?.aluno_nome}".`;
    const dataCi = p?.data || new Date().toISOString().slice(0,10);
    const ch = (dados.changes?.checkins) || {};
    let removidos = 0;
    Object.keys(ch).forEach(ck => {
      if (!ck.includes(dataCi)) return;
      if (p?.hora && !ck.includes(p.hora)) return;
      const antes = (ch[ck].presente||[]).length+(ch[ck].falta||[]).length+(ch[ck].repos||[]).length;
      ch[ck].presente = (ch[ck].presente||[]).filter(x=>x!==aluno.id);
      ch[ck].falta    = (ch[ck].falta   ||[]).filter(x=>x!==aluno.id);
      ch[ck].repos    = (ch[ck].repos   ||[]).filter(x=>x!==aluno.id);
      const depois = ch[ck].presente.length+ch[ck].falta.length+ch[ck].repos.length;
      if (depois<antes) removidos++;
    });
    if (!removidos) return `⚠️ Nenhum check-in encontrado para *${aluno.nome}* em ${dataCi}.`;
    if (dados.changes) { dados.changes.checkins = ch; await saveChanges(dados.changes); }
    return `✅ Check-in desfeito!\n*${aluno.nome}* — ${dataCi.slice(8)}/${dataCi.slice(5,7)}`;
  }

  if (intencao === 'calcular_rescisao') {
    const aluno = dados.alunos.find(a => (p?.aluno_id && a.id===p.aluno_id) ||
      (p?.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase())));
    if (!aluno) return `❌ Aluno não encontrado: "${p?.aluno_nome}".`;
    if (aluno.tipo_plano === 'mensal') return `⚠️ ${aluno.nome} tem plano mensal — não há multa de rescisão. Basta inativar.`;
    const DUR = { trimestral:3, semestral:6 };
    const dur = DUR[aluno.tipo_plano]||3;
    const pags = Object.entries(typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos):aluno.pagamentos||{})
      .filter(e=>e[1]>0).sort((a,b)=>a[0].localeCompare(b[0]));
    // Valor mensal de referência = último pagamento (ou informado)
    const valorMensal = p?.valor || (pags.length?pags[pags.length-1][1]:329);
    const mUsados    = p?.meses_utilizados||1;
    const mNaoUsados = Math.max(0, dur - mUsados);
    // FÓRMULA CLÁUSULA 6 (idêntica ao sistema web):
    // totalPago considera apenas os ÚLTIMOS mUsados pagamentos (plano atual), não todo o histórico
    const pagosPlanoAtual = pags.slice(-mUsados).reduce((s,e)=>s+e[1],0);
    const deveria    = valorMensal * mUsados;
    const diferenca  = deveria - pagosPlanoAtual;
    const multa      = valorMensal * 0.20 * mNaoUsados;
    const saldo      = diferenca + multa;
    return `📋 *Rescisão — ${aluno.nome}*\n\nPlano: ${aluno.tipo_plano} (${dur} meses)\nValor mensal ref.: ${brl(valorMensal)}\nMeses utilizados: ${mUsados} | Não usados: ${mNaoUsados}\n\nDeveria pagar (mensal × usados): ${brl(deveria)}\nPago no plano atual: ${brl(pagosPlanoAtual)}\nDiferença de plano: ${brl(diferenca)}\nMulta 20% × ${mNaoUsados} meses: ${brl(multa)}\n\n*Saldo a pagar: ${brl(saldo)}*\n\n_Confira o valor mensal. Se estiver errado, mande "${aluno.nome.split(' ')[0]} rescindir, ${mUsados} meses, mensal 329"_\n_Para confirmar e lançar: responda_ *sim*`;
  }

  return null;
}

// ── Pendentes (só rescisão) ───────────────────────────────────────
const pendente = {};

// ── Processar mensagem ────────────────────────────────────────────
async function processar(msg) {
  const chatId   = msg.chat.id;
  const username = (msg.from.username||'').toLowerCase();
  const texto    = (msg.text||'').trim();

  // Segurança
  if (ALLOWED_USER && username !== ALLOWED_USER) return tgSend(chatId, '🔒 Acesso não autorizado.');

  // Ignorar mensagens antigas (>60s)
  if ((Math.floor(Date.now()/1000) - (msg.date||0)) > 60) return;

  // Confirmação de rescisão pendente
  if (pendente[chatId]) {
    const conf = pendente[chatId];
    delete pendente[chatId];
    if (['sim','confirmar','ok','s'].includes(texto.toLowerCase())) {
      if (!conf.calc) {
        return tgSend(chatId, '⚠️ Não há cálculo de rescisão para lançar. Refaça o pedido.');
      }
      try {
        // Buscar o aluno atual no banco
        const ra = await sbGet('alunos', `id=eq.${conf.calc.aluno_id}&select=*`);
        const aluno = Array.isArray(ra) && ra[0];
        if (!aluno) return tgSend(chatId, '❌ Aluno não encontrado no banco.');

        const hoje = new Date();
        const hojeStr = hoje.toISOString().slice(0,10);
        const dataFmt = hojeStr.split('-').reverse().join('/');
        const rescMes = hojeStr.slice(0,7);

        // Numeração sequencial da rescisão (consistente com o sistema web)
        let numeroResc = '(via bot)';
        try {
          const rCh = await sbGet('changes', 'select=data&id=eq.1');
          let chData = Array.isArray(rCh) && rCh[0] && rCh[0].data;
          if (typeof chData === 'string') { try { chData = JSON.parse(chData); } catch { chData = null; } }
          if (chData && typeof chData === 'object') {
            const seq = (chData.rescisao_seq || 0) + 1;
            chData.rescisao_seq = seq;
            numeroResc = String(seq).padStart(3,'0') + '/' + hoje.getFullYear();
            await req(SUPABASE_URL+'/rest/v1/changes', 'POST',
              { ...sbHeaders(), Prefer: 'resolution=merge-duplicates' }, { id: 1, data: chData });
          }
        } catch(e) { console.error('rescisao_seq erro:', e.message); }

        // 1. Inativar aluno
        // 2. Registrar inativação + rescisão no histórico
        let hist = aluno.historico_alteracoes;
        if (typeof hist === 'string') { try { hist = JSON.parse(hist); } catch { hist = []; } }
        if (!Array.isArray(hist)) hist = [];
        hist.push({ data: dataFmt, tipo: 'inativacao' });
        hist.push({ data: dataFmt, tipo: 'rescisao', numero: numeroResc, plano: aluno.tipo_plano,
          meses_utilizados: conf.calc.mUsados, valor_mensal: conf.calc.valorMensal, saldo: conf.calc.saldo });

        // 3. Cancelar pendentes futuros (>= mês da rescisão)
        let pend = aluno.pagamentos_pendentes;
        if (typeof pend === 'string') { try { pend = JSON.parse(pend); } catch { pend = {}; } }
        if (!pend || typeof pend !== 'object') pend = {};
        Object.keys(pend).forEach(m => { if (m >= rescMes) delete pend[m]; });

        // 4. Lançar saldo em pagamentos_rescisao no mês seguinte (se houver saldo)
        let pagResc = aluno.pagamentos_rescisao;
        if (typeof pagResc === 'string') { try { pagResc = JSON.parse(pagResc); } catch { pagResc = {}; } }
        if (!pagResc || typeof pagResc !== 'object') pagResc = {};
        if (conf.calc.saldo > 0.01) {
          const dNxt = new Date(hoje.getFullYear(), hoje.getMonth()+1, 1);
          const mNxtStr = dNxt.getFullYear()+'-'+String(dNxt.getMonth()+1).padStart(2,'0');
          pagResc[mNxtStr] = conf.calc.saldo;
        }

        const histTxt = (aluno.historico ? aluno.historico + ' | ' : '') +
          'Rescisão (via bot) em '+dataFmt+': '+aluno.tipo_plano+', '+conf.calc.mUsados+' meses, saldo '+brl(conf.calc.saldo);

        await sbPatch('alunos', `id=eq.${aluno.id}`, {
          ativo: 'NAO',
          historico_alteracoes: hist,
          pagamentos_pendentes: pend,
          pagamentos_rescisao: pagResc,
          historico: histTxt
        });

        const saldoMsg = conf.calc.saldo > 0.01 ? `\n💰 Saldo a receber lançado: ${brl(conf.calc.saldo)}` :
          conf.calc.saldo < -0.01 ? `\n↩️ Saldo a restituir: ${brl(Math.abs(conf.calc.saldo))}` : '\n✅ Quitado';
        return tgSend(chatId, `✅ *Rescisão ${numeroResc} lançada!*\n\n*${aluno.nome}* marcado como inativo.${saldoMsg}\n\n_Emita o termo formal pelo sistema web (botão Rescindir → 2ª via)._`);
      } catch(e) {
        console.error('Lançamento rescisão erro:', e.message);
        return tgSend(chatId, '❌ Erro ao lançar rescisão: '+e.message+'\nTente pelo sistema web.');
      }
    }
    return tgSend(chatId, '❌ Rescisão cancelada.');
  }

  await tgSend(chatId, '⏳ Processando...');
  const mes = new Date().toISOString().slice(0,7);
  // Timeout geral — responde se demorar mais de 45s
  let _timedOut = false;
  const _timer = setTimeout(() => {
    _timedOut = true;
    // Só envia aviso se ainda não respondeu
    if (!_respondeu) tgSend(chatId, '⚠️ Demorou mais que o esperado. Tente novamente em alguns segundos.');
  }, 45000);
  let _respondeu = false;

  let dados;
  try { dados = await getDados(); }
  catch(e) { return tgSend(chatId, '❌ Erro ao conectar ao banco: '+e.message); }

  // Processar com IA
  let aiResult;
  try { aiResult = await processarComIA(texto, dados, mes); }
  catch(e) { console.error('processarComIA erro:', e.message); aiResult = { tipo: 'consulta', resposta: null }; }

  console.log('IA result:', aiResult.tipo, aiResult.intencao||'', '|', texto.slice(0,40));

  // Ajuda / saudacao
  if (aiResult.tipo === 'ajuda' || aiResult.tipo === 'saudacao') {
    _respondeu=true; return tgSend(chatId,
      '👋 *LCA Studio Bot v3.2*\n\n' +
      'Pode me perguntar qualquer coisa sobre o estúdio!\n\n' +
      '*📊 Consultas:*\n' +
      '• _"quem não pagou maio?"_\n' +
      '• _"quem tem plano vencendo?"_\n' +
      '• _"resumo financeiro de maio"_\n' +
      '• _"qual aluna falta mais?"_\n\n' +
      '*💰 Lançamentos:*\n' +
      '• _"custo aluguel 3700 junho"_\n' +
      '• _"kelly deu 2 aulas hoje"_\n' +
      '• _"Ana Lima pagou 329"_\n\n' +
      '*✅ Check-in de aula:*\n' +
      '• _"Luiza presente terça 09:00"_ — marcar presença\n' +
      '• _"Ana faltou hoje 07:00"_ — registrar falta\n' +
      '• _"Maria repôs quinta 10:00"_ — registrar reposição\n\n' +
      '*↩️ Desfazer:*\n' +
      '• _"apagar custo aluguel 2026-05"_\n' +
      '• _"desfazer pagamento Ana maio"_\n' +
      '• _"remover aula kelly"_\n' +
      '• _"desfazer check-in Ana hoje 09:00"_\n\n' +
      '*📋 Rescisão:*\n' +
      '• _"Mara quer rescindir, semestral, pagou 3 meses"_'
    );
  }

  // Consultas diretas — sem IA, resposta imediata
  if (aiResult.tipo === 'consulta_direta') {
    clearTimeout(_timer);
    const tL3 = texto.toLowerCase();
    let resp3 = '';
    if (aiResult.intencao === 'consulta_inadimplentes') {
      const inads = dados.alunos.filter(function(a) {
        if (a.ativo !== 'SIM') return false;
        var pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
        return !(pags[mes]||0);
      });
      resp3 = inads.length
        ? '*Inadimplentes em '+mes+' ('+inads.length+'):*\n' + inads.map(a=>'• '+a.nome+' ('+a.tipo_plano+')').join('\n')
        : '✅ Todos os alunos pagaram em '+mes+'.';
    } else if (aiResult.intencao === 'consulta_financeiro') {
      const rec = dados.alunos.reduce(function(s,a){var p=typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});var pr=typeof a.pagamentos_rescisao==='string'?JSON.parse(a.pagamentos_rescisao||'{}'):(a.pagamentos_rescisao||{});return s+(p[mes]||0)-(pr[mes]||0);},0);
      const cst = dados.custos.filter(function(c){return c.mes===mes;}).reduce(function(s,c){return s+(c.valor||0);},0);
      resp3 = '*Resumo '+mes+':*\n💰 Receita: '+brl(rec)+'\n🔴 Custos: '+brl(cst)+'\n📈 Bruto: '+brl(rec-cst);
    } else if (aiResult.intencao === 'consulta_vencendo') {
      const pv = dados._planosVencendo || [];
      resp3 = pv.length
        ? '*Planos vencendo (próx. 30 dias):*\n' + pv.map(p=>'• '+p.nome+' — '+p.plano+', dia '+p.diaVenc+'/'+p.mesVenc+' ('+p.dias+' dias)').join('\n')
        : 'Nenhum plano vencendo nos próximos 30 dias.';
    }
    _respondeu=true; return tgSend(chatId, resp3 || '❌ Sem dados.');
  }

  // Consulta livre — IA respondeu direto ou fallback estruturado
  if (aiResult.tipo === 'consulta') {
    clearTimeout(_timer);
    if (aiResult.resposta) return tgSend(chatId, aiResult.resposta);
    // Fallback estruturado — sem IA
    try {
      const tL2 = texto.toLowerCase();
      let fallback = '';
      if (tL2.includes('venc') || tL2.includes('plano')) {
        const pv = (dados._planosVencendo || []);
        fallback = pv.length
          ? '*Planos vencendo (próx. 30 dias):*\n' + pv.map(p=>'• '+p.nome+' — '+p.plano+', vence '+p.dataVenc+' ('+p.dias+' dias)').join('\n')
          : 'Nenhum plano vencendo nos próximos 30 dias.';
      } else if (tL2.includes('inadim') || tL2.includes('pagou')) {
        const mesAtual = mes;
        const inads = dados.alunos.filter(function(a) {
          if (a.ativo !== 'SIM') return false;
          var pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
          return !pags[mesAtual];
        });
        fallback = inads.length
          ? '*Inadimplentes em '+mesAtual+':*\n' + inads.map(a=>'• '+a.nome+' ('+a.tipo_plano+')').join('\n')
          : '✅ Todos pagaram em '+mesAtual+'.';
      } else if (tL2.includes('result') || tL2.includes('resumo') || tL2.includes('financ')) {
        const rec = dados.alunos.reduce(function(s,a){var p=typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});var pr=typeof a.pagamentos_rescisao==='string'?JSON.parse(a.pagamentos_rescisao||'{}'):(a.pagamentos_rescisao||{});return s+(p[mes]||0)-(pr[mes]||0);},0);
        const cst = dados.custos.filter(function(c){return c.mes===mes;}).reduce(function(s,c){return s+(c.valor||0);},0);
        fallback = '*Resumo '+mes+':*\n💰 Receita: '+brl(rec)+'\n🔴 Custos: '+brl(cst)+'\n📈 Bruto: '+brl(rec-cst);
      } else {
        fallback = '⚠️ Gemini indisponível. Tente em 1 minuto.\nOu use comandos diretos — mande *ajuda*.';
      }
      _respondeu=true; return tgSend(chatId, fallback);
    } catch(err) {
      console.error('Fallback erro:', err.message);
      _respondeu=true; return tgSend(chatId, '⚠️ Gemini indisponível agora. Tente novamente em 1 minuto.');
    }
  }

  // Ação — params já vêm da IA
  const intencao = aiResult.intencao || 'desconhecido';
  if (!intencao || intencao === 'desconhecido') {
    clearTimeout(_timer);
    _respondeu=true; return tgSend(chatId, '🤔 Não entendi. Mande *ajuda* para ver exemplos.');
  }
  const params = aiResult.params || {};
  // Tentar encontrar aluno_id pelo nome se não veio
  if (params.aluno_nome && !params.aluno_id) {
    const al = dados.alunos.find(function(a){ return a.nome.toLowerCase().includes((params.aluno_nome||'').toLowerCase()); });
    if (al) params.aluno_id = al.id;
  }

  // Rescisão: mostrar cálculo e aguardar confirmação
  if (intencao === 'calcular_rescisao') {
    const preview = await executar(intencao, params, dados);
    clearTimeout(_timer);
    if (preview) {
      // Recalcular os dados estruturados para o lançamento (mesma fórmula do preview)
      const aluno = dados.alunos.find(a => (params?.aluno_id && a.id===params.aluno_id) ||
        (params?.aluno_nome && a.nome.toLowerCase().includes(params.aluno_nome.toLowerCase())));
      if (aluno && aluno.tipo_plano !== 'mensal') {
        const DUR = { trimestral:3, semestral:6 };
        const dur = DUR[aluno.tipo_plano]||3;
        const pags = Object.entries(typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos):aluno.pagamentos||{})
          .filter(e=>e[1]>0).sort((a,b)=>a[0].localeCompare(b[0]));
        const valorMensal = params?.valor || (pags.length?pags[pags.length-1][1]:329);
        const mUsados = params?.meses_utilizados||1;
        const mNaoUsados = Math.max(0, dur - mUsados);
        const pagosPlanoAtual = pags.slice(-mUsados).reduce((s,e)=>s+e[1],0);
        const saldo = (valorMensal*mUsados - pagosPlanoAtual) + (valorMensal*0.20*mNaoUsados);
        pendente[chatId] = { intencao, params, calc: { aluno_id: aluno.id, mUsados, valorMensal, saldo } };
      } else {
        pendente[chatId] = { intencao, params };
      }
      _respondeu=true; return tgSend(chatId, preview);
    }
  }

  const resultado = await executar(intencao, params, dados);
  clearTimeout(_timer);
  if (_timedOut) return;
  _respondeu=true; return tgSend(chatId, resultado || '❌ Não consegui executar a ação.');
}

// ── Loop principal ────────────────────────────────────────────────
async function main() {
  console.log('LCA Bot v3.2 iniciado ✓');
  let offset = 0;
  try {
    const init = await req(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=-1&limit=1&timeout=0`, 'GET', {}, null);
    if (init?.result?.length) offset = init.result[init.result.length-1].update_id+1;
    await req(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&limit=1&timeout=0`, 'GET', {}, null);
    console.log('Fila limpa. Offset:', offset);
  } catch(e) { console.log('Init aviso:', e.message); }

  const processados = {};

  // Servidor HTTP para o Render
  require('http').createServer((req, res) => { res.writeHead(200); res.end('LCA Bot v2 ✓'); })
    .listen(process.env.PORT||3000, () => console.log('HTTP OK'));

  while (true) {
    try {
      const res = await tgUpdates(offset);
      if (res?.result?.length) {
        for (const upd of res.result) {
          offset = upd.update_id+1;
          if (processados[upd.update_id]) continue;
          processados[upd.update_id] = true;
          const ids = Object.keys(processados);
          if (ids.length > 200) delete processados[ids[0]];
          if (upd.message?.text) processar(upd.message).catch(e => console.error('Erro:', e.message));
        }
      }
    } catch(e) {
      console.error('Loop error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main();
