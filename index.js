// LCA Studio Bot — Telegram + Gemini + Supabase
// Versão 2.1 — IA unificada, timeout, desfazeres, check-in

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
  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'];
  for (const model of models) {
    try {
      const r = await aiWithTimeout(req(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        'POST', { 'Content-Type': 'application/json' },
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 800 } },
        12000
      ), 14000);
      if (r?.candidates?.[0]?.content) return r.candidates[0].content.parts[0].text.trim();
      if (r?.error?.code === 503) { console.log(model+' sobrecarregado, tentando próximo...'); continue; }
      if (r?.error) { console.error('Gemini erro em '+model+':', r.error.message); continue; }
    } catch(e) {
      console.error('Gemini '+model+':', e.message);
      if (e.message.includes('timeout')) continue;
    }
  }
  return null;
}

async function aiJSON(prompt) {
  const raw = await ai(prompt + '\n\nRetorne APENAS JSON válido, sem markdown, sem explicação.');
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json\n?/g,'').replace(/```/g,'').trim()); }
  catch(e) { console.error('JSON parse erro:', e.message, '| raw:', raw.slice(0,100)); return null; }
}

// ── Dados ─────────────────────────────────────────────────────────
async function getDados() {
  const [ra, rc, rk] = await Promise.all([
    sbGet('alunos', 'select=id,nome,ativo,tipo_plano,vezes_semana,forma_pagamento,dia_vencimento,professora,prof_secundaria,aulas_prof,pagamentos,pagamentos_pendentes,data_matricula,historico_alteracoes'),
    sbGet('custos', 'select=*&order=id.desc'),
    sbGet('aulas',  'select=*&order=id.desc')
  ]);
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

  const receitaMes = pagMes.reduce((s, a) => s + a.valor, 0);
  const inadimplentes = ativos.filter(a => {
    const pag = pagMes.find(p => p.id === a.id);
    return !pag || !pag.pagou;
  });

  // Custos do mês
  const custosMes = dados.custos.filter(c => c.mes === mes);
  const totalCustos = custosMes.reduce((s, c) => s + (c.valor||0), 0);

  // Professoras
  let totalMonica = 0;
  ativos.forEach(a => {
    const pags = typeof a.pagamentos === 'string' ? JSON.parse(a.pagamentos||'{}') : (a.pagamentos||{});
    const v = pags[mes] || 0;
    if (!v) return;
    if (a.professora === 'monica') totalMonica += v * 0.4;
    else if (a.professora === 'ambas' && a.prof_secundaria === 'monica') {
      totalMonica += v * 0.4 * ((a.aulas_prof||1)/(a.vezes_semana||2));
    }
  });
  const aulasKelly = dados.aulas.filter(k => k.prof_id === 'kelly' && k.mes === mes);
  const totalKelly = aulasKelly.reduce((s, k) => s + (k.horas||k.vh||0)*35, 0);
  const totalLeda = 6000;
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
      return { nome: a.nome, plano: a.tipo_plano, dias, dataVenc: venc.toLocaleDateString('pt-BR'), ultimoMes: lastMes };
    }).filter(p => p && p.dias >= -5 && p.dias <= 30)
    .sort((a,b) => a.dias-b.dias);

  console.log('Planos vencendo calculados:', planosVencendo.length, '| Trim/Sem ativos:', ativos.filter(a=>a.tipo_plano==='trimestral'||a.tipo_plano==='semestral').length);

  return {
    hoje: new Date().toLocaleDateString('pt-BR'),
    mes,
    estudio: { totalAlunos: dados.alunos.length, ativos: ativos.length, inativos: inativos.length },
    financeiro: { receita: receitaMes, professoras: totalProf, custos: totalCustos, resultado,
      detalheProfessoras: { leda: totalLeda, monica: totalMonica, kelly: totalKelly } },
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
  const KEYWORDS = [
    ['lancar_custo',        ['custo ','despesa','aluguel','energia','luz ','internet']],
    ['lancar_aula',         ['aula ','horas de aula','deu aula','deu 1','deu 2','deu 3']],
    ['confirmar_pagamento', ['pagou','pagamento']],
    ['calcular_rescisao',   ['rescindir','rescisão','rescisao','cancelar contrato']],
    ['remover_custo',       ['remover custo','apagar custo','deletar custo','excluir custo','desfazer custo']],
    ['remover_custo_id',    ['remover custo id','apagar custo id']],
    ['desfazer_pagamento',  ['desfazer pagamento','cancelar pagamento']],
    ['desfazer_aula',       ['remover aula','apagar aula','desfazer aula']],
    ['checkin',             ['presente','faltou','falta hoje','reposição','repôs','check-in','checkin']],
    ['desfazer_checkin',    ['desfazer check']],
  ];
  for (const [acao, kws] of KEYWORDS) {
    if (kws.some(k => tL.includes(k))) {
      console.log('Ação por keyword:', acao);
      return { tipo: 'acao', intencao: acao };
    }
  }

  if (['oi','olá','ola','bom dia','boa tarde','boa noite'].some(k => tL.startsWith(k))) {
    return { tipo: 'saudacao' };
  }
  if (['ajuda','help','comando','como usar','o que'].some(k => tL.includes(k))) {
    return { tipo: 'ajuda' };
  }

  // Consulta livre — UMA chamada ao Gemini
  const prompt = `Você é o assistente do LCA Studio de Pilates (Rio de Janeiro, ${ctx.hoje}).
Responda diretamente em Markdown simples. Máximo 5 linhas curtas.

DADOS (${mes}):
Ativos: ${ctx.estudio.ativos} | Inativos: ${ctx.estudio.inativos}
Receita: ${brl(ctx.financeiro.receita)} | Professoras: ${brl(ctx.financeiro.professoras)} | Custos: ${brl(ctx.financeiro.custos)} | Resultado: ${brl(ctx.financeiro.resultado)}
Inadimplentes: ${ctx.inadimplentes.map(a=>a.nome).join(', ')||'Nenhum'}
Planos vencendo (30 dias): ${ctx.planosVencendo.length?ctx.planosVencendo.map(p=>p.nome+' ('+p.plano+', vence '+p.dataVenc+')').join(' | '):'Nenhum'}
Custos: ${ctx.custosMes.map(c=>c.desc+' '+brl(c.valor)).join(', ')||'Nenhum'}
Faltas frequentes: ${ctx.faltasFrequentes.join(', ')||'Nenhuma'}

PERGUNTA: ${texto}`;

  const resp = await ai(prompt);
  return { tipo: 'consulta', resposta: resp };
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
    await sbPost('aulas', { prof_id: profId, mes, data, data_fmt: data.split('-').reverse().join('/'),
      horas: p.horas, vh: p.horas, desc_aula: 'Lançado via Bot Telegram — '+p.horas+'h' });
    return `✅ Aula lançada!\n*${profId}* — ${p.horas}h — ${data}\n_Para desfazer: "remover aula ${profId}"_`;
  }

  if (intencao === 'confirmar_pagamento') {
    const aluno = dados.alunos.find(a => (p?.aluno_id && a.id===p.aluno_id) ||
      (p?.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase())));
    if (!aluno) return `❌ Aluno não encontrado: "${p?.aluno_nome}".`;
    if (!p?.valor) return '❌ Informe o valor.';
    const pags = Object.assign({}, typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos):aluno.pagamentos||{});
    pags[mes] = p.valor;
    const hist = (aluno.historico_alteracoes||[]);
    hist.push({ data: new Date().toLocaleDateString('pt-BR'), tipo:'pagamento_bot',
      desc: `Pagamento ${mes} via Bot Telegram: ${brl(p.valor)}` });
    await sbPatch('alunos', `id=eq.${aluno.id}`, { pagamentos: pags, historico_alteracoes: hist });
    return `✅ Pagamento confirmado!\n*${aluno.nome}* — ${brl(p.valor)} — ${mes}\n_Para desfazer: "desfazer pagamento ${aluno.nome.split(' ')[0]} ${mes}"_`;
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

  if (aiResult.intencao === 'calcular_rescisao') {
    const aluno = dados.alunos.find(a => (p?.aluno_id && a.id===p.aluno_id) ||
      (p?.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase())));
    if (!aluno) return `❌ Aluno não encontrado: "${p?.aluno_nome}".`;
    const DUR = { mensal:1, trimestral:3, semestral:6 };
    const dur = DUR[aluno.tipo_plano]||1;
    const pags = Object.entries(typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos):aluno.pagamentos||{})
      .filter(e=>e[1]>0).sort((a,b)=>a[0].localeCompare(b[0]));
    const totalPago = pags.reduce((s,e)=>s+e[1],0);
    const ultV = pags.length?pags[pags.length-1][1]:329;
    const mUsados    = p?.meses_utilizados||1;
    const mRestantes = dur-mUsados;
    const deveria    = ultV*mUsados;
    const diferenca  = deveria-totalPago;
    const multa      = ultV*0.2*mRestantes;
    const saldo      = diferenca+multa;
    return `📋 *Rescisão — ${aluno.nome}*\n\nPlano: ${aluno.tipo_plano} (${dur} meses)\nMeses utilizados: ${mUsados} | Restantes: ${mRestantes}\n\nDeveria pagar: ${brl(deveria)}\nTotal já pago: ${brl(totalPago)}\nDiferença de plano: ${brl(diferenca)}\nMulta 20% × ${mRestantes} meses: ${brl(multa)}\n\n*Saldo a pagar: ${brl(saldo)}*\n\n_Para confirmar e lançar: responda_ *sim*`;
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
      // TODO: implementar lançamento da rescisão no Supabase
      return tgSend(chatId, '✅ Rescisão registrada! Lembre de atualizar o status do aluno no sistema web.');
    }
    return tgSend(chatId, '❌ Rescisão cancelada.');
  }

  await tgSend(chatId, '⏳ Processando...');
  const mes = new Date().toISOString().slice(0,7);
  // Timeout geral — responde se demorar mais de 45s
  let _timedOut = false;
  const _timer = setTimeout(() => {
    _timedOut = true;
    tgSend(chatId, '⚠️ Demorou mais que o esperado. O Gemini pode estar sobrecarregado. Tente novamente em alguns segundos.');
  }, 45000);

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
    return tgSend(chatId,
      '👋 *LCA Studio Bot v2*\n\n' +
      'Pode me perguntar qualquer coisa sobre o estúdio em linguagem natural!\n\n' +
      '*Exemplos de perguntas:*\n' +
      '• _"Qual aluna falta mais?"_\n' +
      '• _"Como estamos comparado ao mês passado?"_\n' +
      '• _"Quem tem plano vencendo?"_\n\n' +
      '*Exemplos de ações:*\n' +
      '• _"custo aluguel 3700 junho"_\n' +
      '• _"kelly deu 2 aulas hoje"_\n' +
      '• _"Ana Lima pagou 329"_\n' +
      '• _"Luiza presente terça 09:00"_\n' +
      '• _"desfazer pagamento Ana maio"_\n' +
      '• _"Mara quer rescindir, semestral, pagou 3 meses"_'
    );
  }

  // Consulta livre — IA respondeu direto
  if (aiResult.tipo === 'consulta') {
    clearTimeout(_timer);
    if (_timedOut) return;
    if (!aiResult.resposta) return tgSend(chatId, '⚠️ O Gemini não respondeu (cota esgotada ou sobrecarga). Tente em 1 minuto.');
    return tgSend(chatId, aiResult.resposta);
  }

  // Ação que altera dados
  const intencao = aiResult.intencao;
  const params = await extrairParams(intencao, texto, dados);
  if (!params) {
    clearTimeout(_timer);
    return tgSend(chatId, '❌ Não consegui extrair os dados. Tente reformular.');
  }

  // Rescisão: mostrar cálculo e aguardar confirmação
  if (aiResult.intencao === 'calcular_rescisao') {
    const preview = await executar(intencao, params, dados);
    clearTimeout(_timer);
    if (preview) { pendente[chatId] = { intencao, params }; return tgSend(chatId, preview); }
  }

  const resultado = await executar(intencao, params, dados);
  clearTimeout(_timer);
  if (_timedOut) return;
  return tgSend(chatId, resultado || '❌ Não consegui executar a ação.');
}

// ── Loop principal ────────────────────────────────────────────────
async function main() {
  console.log('LCA Bot v2 iniciado ✓');
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
