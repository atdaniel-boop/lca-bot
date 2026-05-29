// LCA Studio Bot — Telegram + Gemini + Supabase
// github: lca-bot | autor: at.daniel@gmail.com

const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://amkuqijbwjspxajiguxz.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const ALLOWED_USER   = (process.env.ALLOWED_USER || '').toLowerCase();

// ── HTTP helper ───────────────────────────────────────────────────
function req(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: headers || {}
    };
    const r = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// ── Telegram ──────────────────────────────────────────────────────
function tgSend(chatId, text) {
  return req(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    'POST',
    { 'Content-Type': 'application/json' },
    { chat_id: chatId, text, parse_mode: 'Markdown' }
  );
}

function tgUpdates(offset) {
  return req(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=25`,
    'GET', {}, null
  );
}

// ── Supabase ──────────────────────────────────────────────────────
function sbHeaders() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

function sbGet(table, query) {
  return req(SUPABASE_URL + '/rest/v1/' + table + '?' + (query||''), 'GET', sbHeaders(), null);
}

function sbPost(table, body) {
  return req(SUPABASE_URL + '/rest/v1/' + table, 'POST', sbHeaders(), body);
}

function sbPatch(table, query, body) {
  return req(SUPABASE_URL + '/rest/v1/' + table + '?' + query, 'PATCH', sbHeaders(), body);
}

// ── Gemini ────────────────────────────────────────────────────────
async function ai(prompt) {
  var models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'];
  for (var i = 0; i < models.length; i++) {
    try {
      var r = await req(
        'https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent?key=' + GEMINI_KEY,
        'POST',
        { 'Content-Type': 'application/json' },
        { contents: [{ parts: [{ text: prompt }] }] }
      );
      if (r && r.candidates && r.candidates[0] && r.candidates[0].content) {
        // modelo funcionou
        return r.candidates[0].content.parts[0].text.trim();
      }
      if (r && r.error && r.error.code === 503) {
        console.log('Modelo ' + models[i] + ' sobrecarregado, tentando proximo...');
        continue;
      }
      if (r && r.error) {
        console.error('Gemini erro em ' + models[i] + ':', r.error.message);
      }
    } catch(e) {
      console.error('Gemini excecao em ' + models[i] + ':', e.message);
    }
  }
  return null;
}

// ── Dados do sistema ──────────────────────────────────────────────
async function getDados() {
  var results = await Promise.all([
    sbGet('alunos', 'select=id,nome,ativo,tipo_plano,vezes_semana,forma_pagamento,dia_vencimento,professora,pagamentos,pagamentos_pendentes,pagamentos_rescisao'),
    sbGet('custos', 'select=*&order=id.desc'),
    sbGet('aulas',  'select=*&order=id.desc')
  ]);
  return {
    alunos: Array.isArray(results[0]) ? results[0] : [],
    custos: Array.isArray(results[1]) ? results[1] : [],
    aulas:  Array.isArray(results[2]) ? results[2] : []
  };
}

// ── Interpretar comando via IA ────────────────────────────────────
async function interpretar(texto, dados) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  const mes  = new Date().toISOString().slice(0, 7);
  const resumoAlunos = dados.alunos
    .map(a => a.id + '|' + a.nome + '|' + a.tipo_plano + '|' + a.vezes_semana + 'x')
    .join('\n');

  const prompt =
    'Você é o assistente do LCA Studio de Pilates (Rio de Janeiro).\n' +
    'Hoje: ' + hoje + ' | Mês atual: ' + mes + '\n\n' +
    'ALUNOS ATIVOS:\n' + resumoAlunos + '\n\n' +
    'COMANDO DO GESTOR: "' + texto + '"\n\n' +
    'Retorne APENAS um JSON válido, sem markdown, sem explicação:\n' +
    '{\n' +
    '  "acao": "consulta_inadimplentes" (quem nao pagou / inadimplentes / em atraso) | "consulta_financeiro" (resumo / faturamento / quanto entrou) | "lancar_custo" (custo / despesa / aluguel / energia) | "lancar_aula" (aula / horas de aula) | "confirmar_pagamento" (pagou / confirmou pagamento) | "calcular_rescisao" (rescindir / cancelar contrato) | "saudacao" (oi / ola / start) | "desconhecido",\n' +
    '  "params": {\n' +
    '    "aluno_id": numero ou null,\n' +
    '    "aluno_nome": string ou null,\n' +
    '    "valor": numero ou null,\n' +
    '    "mes": "YYYY-MM" ou null,\n' +
    '    "categoria": string ou null,\n' +
    '    "descricao": string ou null,\n' +
    '    "professora": string ou null,\n' +
    '    "horas": numero ou null,\n' +
    '    "meses_utilizados": numero ou null,\n' +
    '    "data": "YYYY-MM-DD" ou null\n' +
    '  },\n' +
    '  "confirmacao": "frase resumindo a acao (max 1 linha)"\n' +
    '}';

  const raw = await ai(prompt);
  if (!raw) return null;
  try {
    const clean = raw.replace(/```json\n?/g,'').replace(/```/g,'').trim();
    return JSON.parse(clean);
  } catch(e) {
    console.error('Parse error:', e.message, '| raw:', raw.slice(0,200));
    return null;
  }
}

// ── Formatar valor ────────────────────────────────────────────────
function brl(v) {
  return 'R$ ' + Math.abs(Number(v)).toFixed(2).replace('.', ',');
}

// ── Executar ação ─────────────────────────────────────────────────
async function executar(cmd, dados) {
  const p   = cmd.params;
  const mes = p.mes || new Date().toISOString().slice(0, 7);

  // ── Consulta inadimplentes ──
  if (cmd.acao === 'consulta_inadimplentes') {
    const list = dados.alunos.filter(function(a) {
      var pago   = ((a.pagamentos          || {})[mes]) || 0;
      var aguard = ((a.pagamentos_pendentes || {})[mes]) || 0;
      return pago === 0 && aguard === 0;
    });
    if (!list.length) return '✅ Todos pagaram em ' + mes + '!';
    return '⚠️ *Inadimplentes — ' + mes + '*\n\n' +
      list.map(function(a){ return '• ' + a.nome + ' (' + a.tipo_plano + ')'; }).join('\n');
  }

  // ── Resumo financeiro ──
    if (cmd.acao === 'consulta_financeiro') {
    // Receita: soma pagamentos confirmados de TODOS os alunos (ativos e inativos)
    var total = 0; var pagos = 0;
    dados.alunos.forEach(function(a) {
      var pags = a.pagamentos;
      if (typeof pags === 'string') { try { pags = JSON.parse(pags); } catch(e) { pags = {}; } }
      if (!pags || typeof pags !== 'object') { pags = {}; }
      var v = 0;
      // Try direct key access
      if (pags[mes] !== undefined) {
        v = Number(pags[mes]) || 0;
      } else {
        // Log first aluno's pagamentos keys to debug
        if (total === 0 && pagos === 0 && a.id) {
          console.log('DEBUG pags type:', typeof a.pagamentos, '| keys:', Object.keys(pags).slice(0,3), '| mes buscado:', mes);
        }
      }
      var rescisao = a.pagamentos_rescisao;
      if (typeof rescisao === 'string') { try { rescisao = JSON.parse(rescisao); } catch(e) { rescisao = {}; } }
      if (!rescisao || typeof rescisao !== 'object') rescisao = {};
      var vR = Number(rescisao[mes]) || 0;
      var liq = Math.max(0, v - vR);
      total += liq;
      if (v > 0) pagos++;
    });
    // Custos: filtrar por mês
    var custosMes = dados.custos.filter(function(c){ return c.mes === mes; });
    var totalCustos = custosMes.reduce(function(s,c){ return s + (c.valor||0); }, 0);
    // Professoras: calcular do mês
    var totalProf = 0;
    var ativos = dados.alunos.filter(function(a){ return a.ativo==='SIM'; });
    // Monica: 40% dos alunos dela
    var alunosMonica = ativos.filter(function(a){ return a.professora==='monica'; });
    var recMonica = alunosMonica.reduce(function(s,a){
      var pags = a.pagamentos;
      if (typeof pags==='string'){try{pags=JSON.parse(pags);}catch(e){pags={};}}
      return s + ((pags||{})[mes]||0);
    }, 0);
    totalProf += recMonica * 0.4;
    // Kelly: soma das horas × R$35
    var aulasKelly = dados.aulas.filter(function(k){ return k.prof_id==='kelly' && k.mes===mes; });
    totalProf += aulasKelly.reduce(function(s,k){ return s + (k.horas||0)*35; }, 0);
    var resultado = total - totalProf - totalCustos;
    return '📊 *Resumo ' + mes + '*\n\n' +
      '💰 Receita: *' + brl(total) + '* (' + pagos + ' pagamentos)\n' +
      '👩 Professoras: *' + brl(totalProf) + '*\n' +
      '🔴 Custos: *' + brl(totalCustos) + '*\n' +
      '📈 Resultado líquido: *' + brl(resultado) + '*' +
      (resultado < 0 ? ' ⚠️' : ' ✅');
  }

  if (cmd.acao === 'lancar_custo') {
    if (!p.valor || !p.categoria) return '❌ Informe o valor e a categoria do custo.';
    var descBot = (p.descricao || p.categoria) + ' [via Bot Telegram]';
    await sbPost('custos', {
      descricao: descBot,
      valor: p.valor,
      categoria: p.categoria,
      mes: mes
    });
    return '✅ Custo lançado!\n*' + (p.descricao||p.categoria) + '* — ' + brl(p.valor) + ' — ' + mes;
  }

  // ── Lançar aula ──
  if (cmd.acao === 'lancar_aula') {
    if (!p.horas) return '❌ Informe o número de horas.';
    var profNome = (p.professora || '').toLowerCase();
    var profId = profNome.includes('kelly') ? 'kelly' :
                 profNome.includes('monica') ? 'monica' : 'leda';
    var data = p.data || new Date().toISOString().slice(0, 10);
    await sbPost('aulas', {
      prof_id: profId,
      mes: mes,
      data: data,
      data_fmt: data.split('-').reverse().join('/'),
      horas: p.horas,
      vh: p.horas,
      desc_aula: 'Lançado via Bot Telegram — ' + p.horas + 'h'
    });
    return '✅ Aula lançada!\n*' + (p.professora||profId) + '* — ' + p.horas + 'h — ' + data;
  }

  // ── Confirmar pagamento ──
  if (cmd.acao === 'confirmar_pagamento') {
    var aluno = dados.alunos.find(function(a){
      return (p.aluno_id && a.id === p.aluno_id) ||
             (p.aluno_nome && a.nome.toLowerCase().indexOf(p.aluno_nome.toLowerCase()) >= 0);
    });
    if (!aluno) return '❌ Aluno não encontrado: "' + p.aluno_nome + '".';
    if (!p.valor) return '❌ Informe o valor do pagamento.';
    var pags = Object.assign({}, aluno.pagamentos || {});
    pags[mes] = p.valor;
    // Registrar no historico que foi lancado via bot
    var histBot = aluno.historico_alteracoes || [];
    histBot.push({
      data: new Date().toLocaleDateString('pt-BR'),
      tipo: 'pagamento_bot',
      desc: 'Pagamento ' + mes + ' confirmado via Bot Telegram: ' + brl(p.valor)
    });
    await sbPatch('alunos', 'id=eq.' + aluno.id, { pagamentos: pags, historico_alteracoes: histBot });
    return '✅ Pagamento confirmado!\n*' + aluno.nome + '* — ' + brl(p.valor) + ' — ' + mes;
  }

  // ── Calcular rescisão ──
  if (cmd.acao === 'calcular_rescisao') {
    var aluno = dados.alunos.find(function(a){
      return (p.aluno_id && a.id === p.aluno_id) ||
             (p.aluno_nome && a.nome.toLowerCase().indexOf(p.aluno_nome.toLowerCase()) >= 0);
    });
    if (!aluno) return '❌ Aluno não encontrado: "' + p.aluno_nome + '".';
    var DUR = { mensal: 1, trimestral: 3, semestral: 6 };
    var dur = DUR[aluno.tipo_plano] || 1;
    var pags = Object.entries(aluno.pagamentos || {})
      .filter(function(e){ return e[1] > 0; })
      .sort(function(a,b){ return a[0].localeCompare(b[0]); });
    var totalPago  = pags.reduce(function(s,e){ return s+e[1]; }, 0);
    var ultV       = pags.length ? pags[pags.length-1][1] : 329;
    var mUsados    = p.meses_utilizados || 1;
    var mRestantes = dur - mUsados;
    var deveria    = ultV * mUsados;
    var diferenca  = deveria - totalPago;
    var multa      = ultV * 0.2 * mRestantes;
    var saldo      = diferenca + multa;
    return '📋 *Rescisão — ' + aluno.nome + '*\n\n' +
      'Plano: ' + aluno.tipo_plano + ' (' + dur + ' meses)\n' +
      'Meses utilizados: ' + mUsados + ' | Restantes: ' + mRestantes + '\n\n' +
      'Deveria pagar: ' + brl(deveria) + '\n' +
      'Total já pago: ' + brl(totalPago) + '\n' +
      'Diferença de plano: ' + brl(diferenca) + '\n' +
      'Multa 20% × ' + mRestantes + ' meses: ' + brl(multa) + '\n\n' +
      '*Saldo a pagar: ' + brl(saldo) + '*\n\n' +
      '_Para confirmar e lançar no sistema, responda:_ *sim*';
  }

  // ── Saudação ──
  if (cmd.acao === 'saudacao') {
    return '👋 *LCA Studio Bot*\n\n' +
      'Olá Daniel! Estou pronto. Exemplos:\n\n' +
      '• _"quem não pagou junho?"_\n' +
      '• _"custo aluguel 3500 junho"_\n' +
      '• _"kelly deu 2 aulas hoje"_\n' +
      '• _"Ana Lima pagou 329 boleto"_\n' +
      '• _"resumo financeiro de maio"_\n' +
      '• _"Mara quer rescindir, plano semestral, pagou 2 meses"_';
  }

  return '🤔 Não entendi. Tente reformular ou envie *oi* para ver exemplos.';
}

// ── Confirmações pendentes ────────────────────────────────────────
var pendente = {};

// ── Processar mensagem ────────────────────────────────────────────
async function processar(msg) {
  var chatId   = msg.chat.id;
  var username = (msg.from.username || '').toLowerCase();
  var texto    = (msg.text || '').trim();

  // Segurança: só o usuário autorizado
  if (ALLOWED_USER && username !== ALLOWED_USER) {
    return tgSend(chatId, '🔒 Acesso não autorizado.');
  }

  // Resposta a confirmação pendente
  if (pendente[chatId] && !pendente[chatId].executando) {
    var conf = pendente[chatId];
    if (['sim','confirmar','ok','s'].indexOf(texto.toLowerCase()) >= 0) {
      pendente[chatId].executando = true; // lock para evitar duplicidade
      delete pendente[chatId];
      try {
        var result = await executar(conf.cmd, conf.dados);
        return tgSend(chatId, result);
      } catch(e) {
        return tgSend(chatId, '❌ Erro ao executar: ' + e.message);
      }
    } else {
      delete pendente[chatId];
      return tgSend(chatId, '❌ Cancelado.');
    }
  }

  // Processar novo comando
  await tgSend(chatId, '⏳ Processando...');

  var dados, cmd;
  try {
    dados = await getDados();
  } catch(e) {
    return tgSend(chatId, '❌ Erro ao conectar ao banco de dados: ' + e.message);
  }

  try {
    cmd = await interpretar(texto, dados);
  } catch(e) {
    return tgSend(chatId, '❌ Erro na IA: ' + e.message);
  }

  if (!cmd) {
    return tgSend(chatId, '❌ Não consegui interpretar. Tente novamente.');
  }

  // Ações que precisam de confirmação
  if (['calcular_rescisao','confirmar_pagamento','lancar_custo','lancar_aula'].indexOf(cmd.acao) >= 0) {
    var preview;
    try { preview = await executar(cmd, dados); } catch(e) { preview = cmd.confirmacao || cmd.acao; }
    pendente[chatId] = { cmd: cmd, dados: dados };
    if (cmd.acao === 'calcular_rescisao') {
      return tgSend(chatId, preview);
    }
    return tgSend(chatId, '⚠️ *Confirmar?*\n\n' + cmd.confirmacao + '\n\nResponda *sim* para confirmar.');
  }

  // Consultas: responder direto
  try {
    var resp = await executar(cmd, dados);
    return tgSend(chatId, resp);
  } catch(e) {
    return tgSend(chatId, '❌ Erro: ' + e.message);
  }
}

// ── Loop principal ────────────────────────────────────────────────
async function main() {
  console.log('LCA Bot iniciado ✓');

  // IMPORTANTE: ao iniciar, pular todas as mensagens antigas
  // Isso evita reprocessar mensagens quando o servidor reinicia
  var offset = 0;
  try {
    console.log('Inicializando offset...');
    var init = await req(
      'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getUpdates?offset=-1&limit=1',
      'GET', {}, null
    );
    if (init && init.result && init.result.length > 0) {
      offset = init.result[init.result.length - 1].update_id + 1;
      console.log('Offset inicializado em:', offset, '(mensagens antigas ignoradas)');
    } else {
      console.log('Nenhuma mensagem anterior. Aguardando novas mensagens...');
    }
  } catch(e) {
    console.log('Nao foi possivel inicializar offset:', e.message);
  }

  while (true) {
    try {
      var res = await tgUpdates(offset);
      if (res && res.result && res.result.length) {
        for (var i = 0; i < res.result.length; i++) {
          var upd = res.result[i];
          offset = upd.update_id + 1;
          if (upd.message && upd.message.text) {
            processar(upd.message).catch(function(e){ console.error('Erro:', e.message); });
          }
        }
      }
    } catch(e) {
      console.error('Loop error:', e.message);
      await new Promise(function(r){ setTimeout(r, 5000); });
    }
  }
}


// ── Servidor HTTP mínimo (exigido pelo Render) ────────────────────
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer(function(req, res) {
  res.writeHead(200);
  res.end('LCA Bot rodando ✓');
}).listen(PORT, function() {
  console.log('Servidor HTTP na porta ' + PORT);
});

main();
