// LCA Studio Bot — Telegram + Gemini + Supabase + Banco Inter
// Versão 3.16 — detecção direta de comandos Inter por palavra-chave, prompt clarificado

const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '@atdaniel83'; // seu chat_id para notificações automáticas
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://amkuqijbwjspxajiguxz.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const ALLOWED_USER   = (process.env.ALLOWED_USER || '').toLowerCase();

// ── Banco Inter ───────────────────────────────────────────────────
// Certificados via variáveis de ambiente (INTER_CERT e INTER_KEY)
// Client ID/Secret também via env para segurança
const INTER_CLIENT_ID     = process.env.INTER_CLIENT_ID     || 'bac02151-c212-4982-ab50-35ae5fceaf96';
const INTER_CLIENT_SECRET = process.env.INTER_CLIENT_SECRET || '61897158-54b2-4722-8a99-357628f56050';
const INTER_BASE          = 'cdpj.partners.bancointer.com.br';
const INTER_CERT          = process.env.INTER_CERT || ''; // conteúdo do .crt
const INTER_KEY           = process.env.INTER_KEY  || ''; // conteúdo do .key
const INTER_CONTA         = process.env.INTER_CONTA || ''; // número da conta corrente PJ

let interToken = null;
let interTokenExp = 0;

// Requisição mTLS para a API do Inter
function interReq(path, method, body, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    if (!INTER_CERT || !INTER_KEY) {
      return reject(new Error('Certificados Inter não configurados. Adicione INTER_CERT e INTER_KEY no Render.'));
    }
    const opts = {
      hostname: INTER_BASE,
      port: 443,
      path: path,
      method: method || 'GET',
      cert: INTER_CERT,
      key: INTER_KEY,
      headers: {
        'Content-Type': body ? (path.includes('token') ? 'application/x-www-form-urlencoded' : 'application/json') : undefined,
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(INTER_CONTA && !path.includes('token') ? { 'x-conta-corrente': INTER_CONTA } : {}),
        ...(extraHeaders || {})
      },
      timeout: 20000
    };
    // Remover headers undefined
    Object.keys(opts.headers).forEach(k => opts.headers[k] === undefined && delete opts.headers[k]);
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('Inter timeout')); });
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// Obter token OAuth2 (com cache de 50 minutos)
async function interGetToken(scope) {
  const agora = Date.now();
  if (interToken && agora < interTokenExp) return interToken;
  const body = new URLSearchParams({
    client_id:     INTER_CLIENT_ID,
    client_secret: INTER_CLIENT_SECRET,
    grant_type:    'client_credentials',
    scope:         scope || 'extrato.read boleto-cobranca.read boleto-cobranca.write'
  }).toString();
  const r = await interReq('/oauth/v2/token', 'POST', body, null);
  if (r.data && r.data.access_token) {
    interToken    = r.data.access_token;
    interTokenExp = agora + (r.data.expires_in - 60) * 1000;
    return interToken;
  }
  throw new Error('Inter auth falhou: ' + JSON.stringify(r.data));
}

// Consultar saldo da conta
async function interSaldo() {
  const token = await interGetToken('extrato.read');
  const hoje = new Date().toISOString().slice(0,10);
  const r = await interReq(
    '/banking/v2/saldo',
    'GET', null, token
  );
  return r.data;
}

// Consultar extrato por período
async function interExtrato(dataInicio, dataFim) {
  const token = await interGetToken('extrato.read');
  const r = await interReq(
    '/banking/v2/extrato?dataInicial=' + dataInicio + '&dataFinal=' + dataFim,
    'GET', null, token
  );
  return r.data;
}

// Listar cobranças (boletos) por período
async function interCobranças(situacao, dataInicio, dataFim) {
  const token = await interGetToken('boleto-cobranca.read');
  const params = new URLSearchParams({
    dataInicial: dataInicio,
    dataFinal:   dataFim,
    ...(situacao ? { situacao } : {})
  });
  const r = await interReq(
    '/cobranca/v3/cobrancas?' + params.toString(),
    'GET', null, token
  );
  return r.data;
}

// Emitir boleto de cobrança
async function interEmitirBoleto(dados) {
  // dados: { valor, vencimento, nomePagador, cpfCnpj, email, descricao }
  const token = await interGetToken('boleto-cobranca.write');
  const body = {
    seuNumero:    dados.seuNumero || ('LCA-' + Date.now()),
    valorNominal: dados.valor,
    dataVencimento: dados.vencimento, // YYYY-MM-DD
    numDiasAgenda: 30,
    pagador: {
      cpfCnpj:    dados.cpfCnpj,
      tipoPessoa: dados.cpfCnpj.replace(/\D/g,'').length === 11 ? 'FISICA' : 'JURIDICA',
      nome:       dados.nomePagador,
      email:      dados.email || undefined,
      endereco:   dados.endereco || 'Não informado',
      cidade:     dados.cidade || 'Rio de Janeiro',
      uf:         dados.uf || 'RJ',
      cep:        dados.cep || '20000-000',
      numero:     dados.numero || 'S/N'
    },
    mensagem: {
      linha1: dados.descricao || 'Mensalidade Pilates LCA Studio',
      linha2: 'Ref: ' + (dados.referencia || new Date().toLocaleDateString('pt-BR'))
    }
  };
  const r = await interReq('/cobranca/v3/cobrancas', 'POST', body, token, {
    'x-id-idempotente': require('crypto').randomUUID()
  });
  return r.data;
}

async function interCancelarBoleto(codigoSolicitacao) {
  if (!codigoSolicitacao) return null;
  const token = await interGetToken();
  const r = await interReq(`/cobranca/v3/cobrancas/${codigoSolicitacao}/cancelar`, 'POST',
    { motivoCancelamento: 'PAGAMENTO_EM_OUTRA_FORMA' }, token);
  return r;
}

async function gravarBoleto(alunoId, mes, codigoSolicitacao, seuNumero, valor, vencimento) {
  try {
    await sbPost('boletos', {
      aluno_id: alunoId,
      mes,
      codigo_solicitacao: codigoSolicitacao,
      seu_numero: seuNumero,
      valor,
      vencimento,
      status: 'aberto',
      criado_em: new Date().toISOString()
    });
  } catch(e) {
    console.error('[gravarBoleto] erro:', e.message);
  }
}

async function cancelarBoletoPorMes(alunoId, mes) {
  try {
    const r = await sbGet('boletos', `aluno_id=eq.${alunoId}&mes=eq.${mes}&status=eq.aberto&select=id,codigo_solicitacao`);
    const boletos = r?.data || [];
    for (const b of boletos) {
      if (b.codigo_solicitacao) {
        await interCancelarBoleto(b.codigo_solicitacao);
        await sbPatch('boletos', `id=eq.${b.id}`, { status: 'cancelado', cancelado_em: new Date().toISOString() });
        console.log(`[cancelarBoleto] aluno=${alunoId} mes=${mes} cod=${b.codigo_solicitacao}`);
      }
    }
    return boletos.length;
  } catch(e) {
    console.error('[cancelarBoletoPorMes] erro:', e.message);
    return 0;
  }
}

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

async function tgSendPDF(chatId, pdfUrl, filename, caption) {
  // Baixar o PDF do Inter
  const pdfBuffer = await new Promise((resolve, reject) => {
    const u = new URL(pdfUrl);
    const options = {
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'Accept': 'application/pdf' },
      timeout: 20000
    };
    // Se o link Inter requer mTLS, usar o agente com certificado
    if (INTER_CERT && INTER_KEY && u.hostname.includes('inter')) {
      const tls = require('tls');
      options.agent = new (require('https').Agent)({
        cert: INTER_CERT.includes('-----') ? INTER_CERT : Buffer.from(INTER_CERT, 'base64').toString(),
        key:  INTER_KEY.includes('-----')  ? INTER_KEY  : Buffer.from(INTER_KEY,  'base64').toString(),
        rejectUnauthorized: false
      });
    }
    const chunks = [];
    require('https').get(options, res => {
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout baixando PDF')));
  });

  // Enviar via multipart/form-data para o Telegram
  const boundary = '----TGBoundary' + Date.now();
  const safeFilename = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nMarkdown`,
    `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption||''}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeFilename}"\r\nContent-Type: application/pdf\r\n\r\n`
  ];

  const header = Buffer.from(parts.join('\r\n'));
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, pdfBuffer, footer]);

  return new Promise((resolve, reject) => {
    const r = require('https').request({
      hostname: 'api.telegram.org', port: 443,
      path: `/bot${TELEGRAM_TOKEN}/sendDocument`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
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
  // Inadimplentes = ativos que não pagaram E cujo dia de vencimento já passou neste mês
  const hojeBot = new Date();
  const diaHoje = hojeBot.getDate();
  const mesAtualBot = hojeBot.getFullYear() + '-' + String(hojeBot.getMonth()+1).padStart(2,'0');
  const inadimplentes = ativos.filter(a => {
    const pag = pagMes.find(p => p.id === a.id);
    if (pag && pag.pagou) return false; // Já pagou
    // Só considera inadimplente se o dia de vencimento já passou
    const diaVenc = parseInt(a.dia_vencimento || 10);
    return diaHoje >= diaVenc;
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

  // Comandos Inter — detecção direta por palavra-chave (sem IA)
  const temInter = tL.includes('inter') || tL.includes('banco') || tL.includes('conta');
  if (temInter && (tL.includes('saldo') || tL.includes('quanto tem'))) {
    return { tipo: 'acao', intencao: 'inter_saldo', params: {} };
  }
  if (temInter && (tL.includes('extrato') || tL.includes('transaç') || tL.includes('moviment'))) {
    return { tipo: 'acao', intencao: 'inter_extrato', params: {} };
  }
  if (temInter && (tL.includes('boleto') || tL.includes('cobrança') || tL.includes('cobranca')) && !tL.includes('emitir') && !tL.includes('gerar') && !tL.includes('criar')) {
    return { tipo: 'acao', intencao: 'inter_boletos', params: {} };
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

REGRAS DE INTENCAO (siga rigorosamente):
- "saldo da conta/inter/banco", "quanto tem no banco" → inter_saldo
- "extrato", "movimentação da conta", "transações" → inter_extrato
- "resumo financeiro", "resultado do mes", "receita do estudio" → consulta
- "saldo" sem mencao a banco/conta/Inter → consulta sobre o estudio

MENSAGEM: "${texto}"

Retorne JSON (sem markdown):
{
  "tipo": "consulta" ou "acao",
  "resposta": "resposta em Markdown se consulta, null se acao",
  "intencao": null se consulta, ou lancar_custo/lancar_aula/confirmar_pagamento/calcular_rescisao/remover_custo/remover_custo_id/desfazer_pagamento/desfazer_aula/checkin/desfazer_checkin/inter_saldo/inter_extrato/inter_boletos/inter_emitir_boleto/inter_emitir_plano/inter_cancelar_boleto,
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
    // Cancelar boleto em aberto no Inter (se houver)
    const nCancelados = await cancelarBoletoPorMes(aluno.id, mes);
    const msgCancelamento = nCancelados > 0 ? '\n_Boleto Inter cancelado automaticamente._' : '';
    return `✅ Pagamento confirmado!\n*${aluno.nome}* — ${brl(p.valor)} — ${mes}${tinhaPend?'\n_(boleto que estava aguardando foi baixado)_':''}${msgCancelamento}\n_Para desfazer: "desfazer pagamento ${aluno.nome.split(' ')[0]} ${mes}"_`;
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
    const DIAS_PT = ['Dom','Seg','Ter','Qua','Qui','Sex','Sab'];
    const dow = new Date(dataCi+'T12:00:00').getDay();
    const diaKey = DIAS_PT[dow];
    // Buscar horários válidos do aluno neste dia da semana
    const horariosValidos = [];
    for (const [slotKey, slot] of Object.entries(dados.changes?.agenda||{})) {
      if (slot && (slot.alunos||[]).includes(aluno.id)) {
        const hora = slotKey.match(/\d{2}:\d{2}/)?.[0];
        if (hora && slotKey.includes(diaKey)) horariosValidos.push(hora);
      }
    }
    // Hora informada: validar contra agenda
    let horaCi = p?.hora || null;
    if (horaCi && horariosValidos.length > 0 && !horariosValidos.includes(horaCi)) {
      return `⚠️ Horário *${horaCi}* não consta na agenda de *${aluno.nome.split(' ')[0]}* para ${diaKey}.\nHorários cadastrados: ${horariosValidos.join(', ')}\nUse um dos horários acima ou corrija a agenda.`;
    }
    // Se não informada, busca o primeiro slot
    if (!horaCi && horariosValidos.length > 0) horaCi = horariosValidos[0];
    if (!horaCi) {
      return `⚠️ Não consegui identificar o horário da aula de *${aluno.nome}*.\nInforme o horário: _"check-in ${aluno.nome.split(' ')[0]} hoje 10:00"_`;
    }
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
    const dow2 = new Date(dataCi+'T12:00:00').getDay();
    const LABEL = { presente:'✅ Presente', falta:'❌ Falta', repos:'🔄 Reposição' };
    return `${LABEL[status]} registrado!\n*${aluno.nome}* — ${DIAS[dow2]} ${dataCi.slice(8)}/${dataCi.slice(5,7)} ${horaCi}\n_Recarregue o site para ver o check-in atualizado._`;
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

  // ── Banco Inter ────────────────────────────────────────────────
  if (intencao === 'inter_saldo') {
    try {
      const s = await interSaldo();
      if (s && s.disponivel !== undefined) {
        // Horário em BRT (UTC-3)
        const agora = new Date(Date.now() - 3*60*60*1000);
        const horaStr = agora.toISOString().replace('T',' ').slice(0,16) + ' (BRT)';
        return `🏦 *Saldo Banco Inter*\n\n` +
          `💰 Disponível: *${brl(s.disponivel)}*\n` +
          (s.bloqueadoCheque   ? `🔒 Bloqueado Cheque: ${brl(s.bloqueadoCheque)}\n` : '') +
          (s.bloqueadoJudicial ? `⚖️ Bloqueado Judicial: ${brl(s.bloqueadoJudicial)}\n` : '') +
          `\n_Consultado em ${horaStr}_`;
      }
      return '⚠️ Resposta inesperada do Inter: ' + JSON.stringify(s);
    } catch(e) { return '❌ Erro Inter: ' + e.message; }
  }

  if (intencao === 'inter_extrato') {
    try {
      const hoje = new Date();
      const dataFim = hoje.toISOString().slice(0,10);
      // Extrato dos últimos 30 dias por padrão (não só mês corrente)
      const dataInicio = p?.data_inicio || new Date(hoje.getTime() - 30*24*60*60*1000).toISOString().slice(0,10);
      const ext = await interExtrato(dataInicio, dataFim);
      console.log('[EXTRATO] resposta raw:', JSON.stringify(ext).slice(0,300));
      const transacoes = ext?.transacoes || ext?.content || ext?.items || (Array.isArray(ext) ? ext : []);
      if (!transacoes.length) return `📄 *Extrato Inter* (${dataInicio} a ${dataFim})\n\n_Nenhuma transação encontrada._\n\nResposta bruta: ${JSON.stringify(ext).slice(0,200)}`;
      const linhas = transacoes.slice(0,15).map(t => {
        const tipo = t.tipoTransacao || t.tipoOperacao || t.tipo || '';
        const sinal = (tipo === 'D' || tipo === 'DEBITO' || (t.valor||0) < 0) ? '🔴' : '🟢';
        const val = brl(Math.abs(t.valor || t.valorOperacao || 0));
        const desc = (t.titulo || t.descricao || t.historico || tipo).slice(0,35);
        const data = (t.dataTransacao || t.dataOperacao || t.data || '').slice(0,10).split('-').reverse().join('/');
        return `${sinal} ${data} ${val} — ${desc}`;
      }).join('\n');
      return `📄 *Extrato Inter* (${dataInicio.split('-').reverse().join('/')} a ${dataFim.split('-').reverse().join('/')})\n\n${linhas}` +
        (transacoes.length > 15 ? `\n\n_...e mais ${transacoes.length - 15} transações._` : '');
    } catch(e) { return '❌ Erro extrato Inter: ' + e.message; }
  }

  if (intencao === 'inter_boletos') {
    try {
      const hoje = new Date();
      const dataFim = hoje.toISOString().slice(0,10);
      const dataInicio = p?.data_inicio || new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0,10);
      const situacao = p?.situacao || null;
      const result = await interCobranças(situacao, dataInicio, dataFim);
      const lista = result?.content || result?.cobrancas || [];
      if (!lista.length) return `📋 *Boletos Inter*\n\n_Nenhuma cobrança encontrada no período_`;
      const linhas = lista.slice(0,15).map(b => {
        const status = b.situacao === 'PAGO' ? '✅' : b.situacao === 'CANCELADO' ? '❌' : '⏳';
        const val = brl(b.valorNominal || 0);
        const nome = (b.pagador?.nome || '').split(' ').slice(0,2).join(' ');
        const venc = (b.dataVencimento||''). split('-').reverse().join('/');
        return `${status} ${venc} ${val} — ${nome}`;
      }).join('\n');
      return `📋 *Boletos Inter* (${situacao||'todos'})\n\n${linhas}` +
        (lista.length > 15 ? `\n\n_...e mais ${lista.length-15}_` : '');
    } catch(e) { return '❌ Erro boletos Inter: ' + e.message; }
  }

  if (intencao === 'inter_emitir_boleto') {
    const aluno = dados.alunos.find(a =>
      (p?.aluno_id && a.id===p.aluno_id) ||
      (p?.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase()))
    );
    if (!aluno) return `❌ Aluno não encontrado: "${p?.aluno_nome}".`;
    const hoje = new Date();
    const venc = p?.vencimento || new Date(hoje.getFullYear(), hoje.getMonth(), aluno.dia_vencimento||10).toISOString().slice(0,10);
    const cpf = aluno.cpf ? aluno.cpf.replace(/\D/g,'') : '';
    if (!cpf) return `⚠️ *${aluno.nome}* não tem CPF cadastrado. Cadastre na ficha antes de emitir o boleto.`;
    // Calcular valor automaticamente
    const _pendB = typeof aluno.pagamentos_pendentes==='string'?JSON.parse(aluno.pagamentos_pendentes||'{}'):(aluno.pagamentos_pendentes||{});
    const _pagsB = typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos||'{}'):(aluno.pagamentos||{});
    const _pVals = Object.values(_pendB).filter(v=>v>0);
    const _gVals = Object.values(_pagsB).filter(v=>v>0).sort();
    const valorBoleto = p?.valor ||
      (_pVals.length ? _pVals[_pVals.length-1] : null) ||
      (_gVals.length ? _gVals[_gVals.length-1] : null) ||
      aluno.valor_referencia || 0;
    if (!valorBoleto) {
      ctx[chatId] = { intencao: 'inter_emitir_boleto', aluno_id: aluno.id, aluno_nome: aluno.nome, aguardando: 'valor', mes };
      return `⚠️ Não encontrei o valor do plano de *${aluno.nome.split(' ')[0]}*.\nQual o valor? (ex: 329)`;
    }
    try {
      const result = await interEmitirBoleto({
        valor: valorBoleto, vencimento: venc,
        nomePagador: aluno.nome, cpfCnpj: cpf,
        email: aluno.email || undefined,
        endereco: aluno.logradouro || aluno.endereco || 'Não informado',
        cidade: aluno.cidade ? aluno.cidade.split('-')[0].trim() : 'Rio de Janeiro',
        uf: aluno.cidade ? (aluno.cidade.split('-')[1]||'RJ').trim() : 'RJ',
        cep: aluno.cep ? aluno.cep.replace(/\D/g,'').slice(0,8) : '20000000',
        numero: aluno.numero || 'S/N',
        descricao: 'Mensalidade Pilates LCA Studio — ' + aluno.nome.split(' ')[0],
        referencia: new Date().toLocaleDateString('pt-BR'),
        seuNumero: 'LCA-' + aluno.id + '-' + mes
      });
      if (result?.codigoSolicitacao || result?.nossoNumero) {
        const cod = result.codigoSolicitacao || result.nossoNumero;
        const link = result.linkVisualizacaoBoleto || result.link || '';
        // Gravar boleto na tabela boletos
        await gravarBoleto(aluno.id, mes, cod, 'LCA-' + aluno.id + '-' + mes, p.valor, venc);
        const mesNomeAvulso = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][parseInt(mes.slice(5,7))-1];
        const anoAvulso = mes.slice(0,4);
        const nomeArq = `Boleto - ${aluno.nome.split(' ')[0]} - ${mesNomeAvulso} ${anoAvulso}.pdf`;
        const caption = `✅ *Boleto emitido!*\n\n👤 ${aluno.nome}\n💰 ${brl(p.valor)}\n📅 Vencimento: ${venc.split('-').reverse().join('/')}\n🔑 Código: ${cod}`;
        if (link) {
          try {
            await tgSendPDF(chatId, link, nomeArq, caption);
            return null; // já enviou o arquivo
          } catch(ePdf) {
            console.error('[PDF avulso]', ePdf.message);
          }
        }
        return caption + (link ? `\n\n[Visualizar boleto](${link})` : '') +
          `\n\n_Use "confirmar pagamento ${aluno.nome.split(' ')[0]}" quando pagar._`;
      }
      return '⚠️ Resposta: ' + JSON.stringify(result).slice(0,200);
    } catch(e) { return '❌ Erro emissão boleto: ' + e.message; }
  }




  if (intencao === 'inter_emitir_plano') {
    const aluno = dados.alunos.find(a =>
      (p?.aluno_id && a.id===p.aluno_id) ||
      (p?.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase()))
    );
    if (!aluno) return `❌ Aluno não encontrado: "${p?.aluno_nome}".`;
    const cpf = aluno.cpf ? aluno.cpf.replace(/\D/g,'') : '';
    if (!cpf) return `⚠️ *${aluno.nome}* não tem CPF cadastrado. Cadastre na ficha antes de emitir boletos.`;

    const DURACAO = { mensal:1, trimestral:3, semestral:6 };
    const plano = aluno.tipo_plano || 'mensal';
    const dur = DURACAO[plano] || 1;

    // Calcular valor automaticamente: último pagamento pendente > último pago > valor_referencia
    const pend = typeof aluno.pagamentos_pendentes==='string'?JSON.parse(aluno.pagamentos_pendentes||'{}'):(aluno.pagamentos_pendentes||{});
    const pags = typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos||'{}'):(aluno.pagamentos||{});
    const pendVals = Object.values(pend).filter(v=>v>0);
    const pagVals  = Object.values(pags).filter(v=>v>0);
    const valorAuto = p?.valor ||
      (pendVals.length ? pendVals[pendVals.length-1] : null) ||
      (pagVals.length  ? pagVals[pagVals.length-1]   : null) ||
      aluno.valor_referencia || 0;

    if (!valorAuto) {
      // Salvar contexto e pedir valor
      ctx[chatId] = { intencao: 'inter_emitir_plano', aluno_id: aluno.id, aluno_nome: aluno.nome, aguardando: 'valor', mes };
      return `⚠️ Não encontrei o valor do plano de *${aluno.nome.split(' ')[0]}*.\nQual o valor mensal? (ex: 329)`;
    }
    const valor = valorAuto;

    let anoBase, mesBase;
    if (p?.mes) {
      const pm = p.mes.split('-');
      anoBase = parseInt(pm[0]); mesBase = parseInt(pm[1]) - 1;
    } else {
      const hoje = new Date();
      anoBase = hoje.getFullYear(); mesBase = hoje.getMonth();
    }

    const diaVenc = aluno.dia_vencimento || 10;
    const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const fmtData = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;

    const dtInicio = new Date(anoBase, mesBase, diaVenc);
    const dtFim    = new Date(anoBase, mesBase + dur - 1, diaVenc);
    const periodoPlano = `${fmtData(dtInicio)} a ${fmtData(dtFim)}`;
    const planoLabel = plano.charAt(0).toUpperCase() + plano.slice(1);

    const resultados = [];
    let erros = 0;

    for (let i = 0; i < dur; i++) {
      const dtVenc  = new Date(anoBase, mesBase + i, diaVenc);
      const anoVenc = dtVenc.getFullYear();
      const mesVenc = String(dtVenc.getMonth()+1).padStart(2,'0');
      const mesStr  = `${anoVenc}-${mesVenc}`;
      const mesNome = MESES_PT[dtVenc.getMonth()];
      const numBoleto = i + 1;

      const descricao =
        `Plano ${planoLabel} LCA Studio - ${periodoPlano} ` +
        `Boleto ${numBoleto} - ${mesNome} ${anoVenc}`;

      try {
        const result = await interEmitirBoleto({
          valor, vencimento: dtVenc.toISOString().slice(0,10),
          nomePagador: aluno.nome, cpfCnpj: cpf,
          email: aluno.email || undefined,
          endereco: aluno.logradouro || aluno.endereco || 'Nao informado',
          cidade: aluno.cidade ? aluno.cidade.split('-')[0].trim() : 'Rio de Janeiro',
          uf: aluno.cidade ? (aluno.cidade.split('-')[1]||'RJ').trim() : 'RJ',
          cep: aluno.cep ? aluno.cep.replace(/\D/g,'').slice(0,8) : '20000000',
          numero: aluno.numero || 'S/N',
          descricao,
          referencia: `Boleto ${numBoleto} - ${mesNome} ${anoVenc}`,
          seuNumero: `LCA-${aluno.id}-${mesStr}`
        });
        const cod  = result?.codigoSolicitacao || result?.nossoNumero || '?';
        const link = result?.linkVisualizacaoBoleto || result?.link || '';
        // Gravar boleto na tabela
        if (result?.codigoSolicitacao) {
          await gravarBoleto(aluno.id, mesStr, result.codigoSolicitacao, `LCA-${aluno.id}-${mesStr}`, valor, dtVenc.toISOString().slice(0,10));
        }
        // Enviar PDF com nome correto
        const nomeArq = `Boleto ${numBoleto} - ${mesNome} ${anoVenc} - ${aluno.nome.split(' ')[0]}.pdf`;
        if (link) {
          try {
            await tgSendPDF(chatId,link, nomeArq,
              `📄 Boleto ${numBoleto}/${dur} — ${mesNome} ${anoVenc} | vence ${fmtData(dtVenc)} | ${brl(valor)}`);
          } catch(ePdf) {
            console.error(`[PDF plano ${numBoleto}]`, ePdf.message);
            resultados.push(`${numBoleto}. *${mesNome} ${anoVenc}* — vence ${fmtData(dtVenc)} — [ver](${link})`);
          }
        } else {
          resultados.push(`${numBoleto}. *${mesNome} ${anoVenc}* — vence ${fmtData(dtVenc)} — cod: ${cod}`);
        }
      } catch(e) {
        resultados.push(`${numBoleto}. *${mesNome} ${anoVenc}* — ❌ ${e.message.slice(0,60)}`);
        erros++;
      }
      if (i < dur - 1) await new Promise(r => setTimeout(r, 800));
    }

    const status = erros === 0 ? '✅' : erros === dur ? '❌' : '⚠️';
    const resumo = `${status} *Plano ${planoLabel} — ${aluno.nome.split(' ')[0]}*\n` +
      `📋 ${periodoPlano}\n💰 ${brl(valor)}/mês × ${dur} boletos` +
      (resultados.length ? '\n\n' + resultados.join('\n') : '') +
      (erros === 0 ? '\n\n_Baixa automática via webhook quando pagos._' : '');
    return resumo;
  }


  if (intencao === 'inter_cancelar_boleto') {
    const aluno = dados.alunos.find(a =>
      (p?.aluno_id && a.id===p.aluno_id) ||
      (p?.aluno_nome && a.nome.toLowerCase().includes(p.aluno_nome.toLowerCase()))
    );
    if (!aluno) return `❌ Aluno não encontrado: "${p?.aluno_nome}".`;
    const mes = p?.mes || new Date().toISOString().slice(0,7);
    try {
      const r = await sbGet('boletos', `aluno_id=eq.${aluno.id}&mes=eq.${mes}&status=eq.aberto&select=id,codigo_solicitacao,valor,vencimento`);
      const boletos = r?.data || [];
      if (!boletos.length) return `ℹ️ Nenhum boleto em aberto para *${aluno.nome.split(' ')[0]}* em ${mes}.`;
      let cancelados = 0;
      for (const b of boletos) {
        await interCancelarBoleto(b.codigo_solicitacao);
        await sbPatch('boletos', `id=eq.${b.id}`, { status: 'cancelado', cancelado_em: new Date().toISOString() });
        cancelados++;
      }
      return `✅ *${cancelados} boleto(s) cancelado(s) no Inter!*\n\n👤 ${aluno.nome}\n📅 Mês: ${mes}\n\n_Pagamento recebido por outro meio._`;
    } catch(e) {
      return `❌ Erro ao cancelar boleto: ${e.message}`;
    }
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
  // Extrair mês do texto da mensagem (ex: "maio", "junho", "04/2026", "2026-05")
  const MESES_PT = {janeiro:'01',fevereiro:'02',março:'03',marco:'03',abril:'04',maio:'05',junho:'06',julho:'07',agosto:'08',setembro:'09',outubro:'10',novembro:'11',dezembro:'12'};
  var _mesMatch = null;
  var _tL = msg.text ? msg.text.toLowerCase() : '';
  // Tentar nome do mês em português
  for (var _mn in MESES_PT) { if (_tL.includes(_mn)) { var _d = new Date(); _mesMatch = _d.getFullYear() + '-' + MESES_PT[_mn]; break; } }
  // Tentar formato MM/AAAA ou AAAA-MM
  if (!_mesMatch) { var _mm = _tL.match(/(\d{2})\/(\d{4})/); if (_mm) _mesMatch = _mm[2]+'-'+_mm[1]; }
  if (!_mesMatch) { var _mm2 = _tL.match(/(\d{4})-(\d{2})/); if (_mm2) _mesMatch = _mm2[0]; }
  const mes = _mesMatch || new Date().toISOString().slice(0,7);
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

  // Restaurar contexto anterior se mensagem for só um número (valor)
  if (/^\d+([.,]\d+)?$/.test(texto.trim()) && ctx[chatId]) {
    const c = ctx[chatId];
    if (c.aguardando === 'valor' && c.intencao) {
      const valorInformado = parseFloat(texto.replace(',','.'));
      const aluno = dados.alunos.find(a => a.id === c.aluno_id);
      if (aluno) {
        clearTimeout(_timer);
        delete ctx[chatId];
        _respondeu = true;
        const resultado = await executar(c.intencao, { aluno_id: c.aluno_id, aluno_nome: c.aluno_nome, valor: valorInformado, mes: c.mes }, dados);
        if (resultado === null) return;
        return tgSend(chatId, resultado || '❌ Erro ao executar.');
      }
    }
  }

  // Processar com IA
  let aiResult;
  try { aiResult = await processarComIA(texto, dados, mes); }
  catch(e) { console.error('processarComIA erro:', e.message); aiResult = { tipo: 'consulta', resposta: null }; }

  console.log('IA result:', aiResult.tipo, aiResult.intencao||'', '|', texto.slice(0,40));

  // Ajuda / saudacao
  if (aiResult.tipo === 'ajuda' || aiResult.tipo === 'saudacao') {
    _respondeu=true; return tgSend(chatId,
      '👋 *LCA Studio Bot v3.6*\n\n' +
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
      '• _"saldo da conta"_ — saldo Banco Inter\n' +
      '• _"extrato de hoje"_ / _"extrato do mês"_ — extrato Inter\n' +
      '• _"boletos em aberto"_ / _"boletos pagos este mês"_ — cobranças\n' +
      '• _"emitir boleto Ana R$ 329 vence dia 10"_ — emitir 1 boleto avulso\n' +
      '• _"emitir plano Ana"_ — emitir todos os boletos do plano de uma vez (trimestral=3, semestral=6)\n\n' +
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
        const mesRes = _mesMatch || mes; // usa mês extraído do texto
        const rec = dados.alunos.reduce(function(s,a){var p=typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});var pr=typeof a.pagamentos_rescisao==='string'?JSON.parse(a.pagamentos_rescisao||'{}'):(a.pagamentos_rescisao||{});return s+(p[mesRes]||0)-(pr[mesRes]||0);},0);
        const cst = dados.custos.filter(function(c){return c.mes===mesRes;}).reduce(function(s,c){return s+(c.valor||0);},0);
        const resultado = rec - cst;
        const resIcon = resultado >= 0 ? '📈 *Resultado: +' : '📉 *Resultado: ';
        fallback = '*Resumo ' + mesRes + ':*\n💰 Receita: ' + brl(rec) + '\n🔴 Custos: ' + brl(cst) + '\n' + resIcon + brl(Math.abs(resultado)) + '*' + (resultado < 0 ? ' ⚠️ NEGATIVO' : '');
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
  _respondeu=true;
  if (resultado === null) return; // PDF já enviado diretamente
  return tgSend(chatId, resultado || '❌ Não consegui executar a ação.');
}

// ── Loop principal ────────────────────────────────────────────────
async function main() {
  console.log('LCA Bot v3.6 iniciado ✓');
  let offset = 0;
  try {
    const init = await req(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=-1&limit=1&timeout=0`, 'GET', {}, null);
    if (init?.result?.length) offset = init.result[init.result.length-1].update_id+1;
    await req(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&limit=1&timeout=0`, 'GET', {}, null);
    console.log('Fila limpa. Offset:', offset);
  } catch(e) { console.log('Init aviso:', e.message); }

  const processados = {};
  const ctx = {}; // contexto por chatId: { intencao, aluno_id, aluno_nome, aguardando }

  // Servidor HTTP para o Render + endpoint /ping para keep-alive (UptimeRobot)
  require('http').createServer(async (req, res) => {
    if (req.url === '/ping') {
      res.writeHead(200, {'Content-Type':'text/plain'});
      res.end('pong');

    // ── Webhook do Banco Inter ──────────────────────────────────────────────
    } else if (req.url === '/webhook-inter' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          console.log('[WEBHOOK-INTER]', JSON.stringify(payload).slice(0, 300));

          // Inter envia evento "PAGO" com o seuNumero que gravamos na emissão
          const evento = payload?.evento || payload?.tipo || '';
          const seuNum = payload?.seuNumero || payload?.cobranca?.seuNumero || '';
          const valorPago = parseFloat(payload?.valorTotalRecebido || payload?.valor || 0);
          const dataPag = payload?.dataLiquidacao || payload?.dataPagamento || new Date().toISOString().slice(0,10);

          // seuNumero formato: "LCA-{id}-{mes}" ex: "LCA-96-2026-06"
          const match = seuNum.match(/^LCA-(\d+)-(\d{4}-\d{2})$/);

          if (match && valorPago > 0 && (evento.includes('PAGO') || evento.includes('LIQUIDADO') || evento === '')) {
            const alunoId = parseInt(match[1]);
            const mes = match[2];

            // Carregar dados do Supabase
            const [rAlunos] = await Promise.all([
              sbGet('alunos', `select=id,nome,pagamentos,pagamentos_pendentes,historico_alteracoes&id=eq.${alunoId}`)
            ]);
            const aluno = rAlunos?.data?.[0];

            if (aluno) {
              const pags = Object.assign({}, typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos||'{}'):(aluno.pagamentos||{}));
              let pend = Object.assign({}, typeof aluno.pagamentos_pendentes==='string'?JSON.parse(aluno.pagamentos_pendentes||'{}'):(aluno.pagamentos_pendentes||{}));

              // Só confirmar se ainda não está pago
              if (!(pags[mes] > 0)) {
                pags[mes] = valorPago;
                const tinhaPend = !!pend[mes];
                if (tinhaPend) delete pend[mes];

                const hist = Array.isArray(aluno.historico_alteracoes) ? [...aluno.historico_alteracoes] : [];
                hist.push({ data: new Date(dataPag+'T12:00:00').toLocaleDateString('pt-BR'), tipo: 'pagamento_auto',
                  desc: `Pagamento ${mes} via boleto Inter (automático): ${brl(valorPago)}` });

                const patch = { pagamentos: pags, historico_alteracoes: hist };
                if (tinhaPend) patch.pagamentos_pendentes = pend;
                await sbPatch('alunos', `id=eq.${alunoId}`, patch);
                // Marcar boleto como pago na tabela
                try {
                  await sbPatch('boletos', `aluno_id=eq.${alunoId}&mes=eq.${mes}&status=eq.aberto`,
                    { status: 'pago', pago_em: new Date().toISOString() });
                } catch(e) { console.error('[webhook] erro ao marcar boleto pago:', e.message); }

                // Notificar via Telegram
                const chatId = TELEGRAM_CHAT_ID;
                if (chatId) {
                  await tgSend(chatId, `🏦 *Pagamento confirmado automaticamente!*\n\n👤 ${aluno.nome}\n💰 ${brl(valorPago)}\n📅 ${mes} — pago em ${dataPag.split('-').reverse().join('/')}\n_Boleto Inter baixado automaticamente._`);
                }
                console.log(`[WEBHOOK-INTER] Pagamento confirmado: aluno ${alunoId} mes ${mes} valor ${valorPago}`);
              } else {
                console.log(`[WEBHOOK-INTER] Pagamento já existe para aluno ${alunoId} mes ${mes} — ignorado`);
              }
            } else {
              console.log(`[WEBHOOK-INTER] Aluno ${alunoId} não encontrado`);
            }
          } else {
            console.log(`[WEBHOOK-INTER] Evento ignorado: evento="${evento}" seuNum="${seuNum}" valor=${valorPago}`);
          }
        } catch(e) {
          console.error('[WEBHOOK-INTER] Erro:', e.message);
        }
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end('{"ok":true}');
      });

    // ── Cadastrar webhook no Inter (chamar uma vez via browser) ────────────
    } else if (req.url === '/cadastrar-webhook-inter' && req.method === 'GET') {
      try {
        const token = await interGetToken();
        const webhookUrl = process.env.RENDER_EXTERNAL_URL + '/webhook-inter';
        const r = await interReq('/cobranca/v3/cobrancas/webhook', 'PUT',
          { webhookUrl }, token);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, webhookUrl, resposta: r }));
      } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ erro: e.message }));
      }

    } else {
      res.writeHead(200, {'Content-Type':'text/plain'});
      res.end('LCA Bot v3.8 ✓ — ' + new Date().toLocaleString('pt-BR'));
    }
  }).listen(process.env.PORT||3000, () => console.log('HTTP OK — /ping disponível'));

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
