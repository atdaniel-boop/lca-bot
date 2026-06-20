// LCA Studio Bot - Telegram + Gemini + Supabase + Banco Inter
// Versão 9.9 - corrigido reenviar com filtro: mes/valor era incluido no nomeCandidato causando 'aluno nao encontrado'. Agora extrai o filtro primeiro, remove do texto, depois busca o aluno pelo nome limpo

// ── LCA Studio Bot — Telegram + Gemini + Supabase + Banco Inter ────────────────
const https = require('https');

const BOT_VERSION = '9.9'; // fonte única da versão — usada no log, health check, ajuda e backup

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '210213875'; // ID numérico de @atdaniel83
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://amkuqijbwjspxajiguxz.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const ALLOWED_USER   = (process.env.ALLOWED_USER || '').toLowerCase();
const COMANDO_TOKEN  = process.env.COMANDO_TOKEN || 'lca-studio-2026'; // token secreto p/ endpoint /comando do site (configure COMANDO_TOKEN no Render p/ maior segurança)

// Certificados via variáveis de ambiente (INTER_CERT e INTER_KEY)
// Client ID/Secret APENAS via variáveis de ambiente - nunca hardcoded no código
const INTER_CLIENT_ID     = process.env.INTER_CLIENT_ID     || '';
const INTER_CLIENT_SECRET = process.env.INTER_CLIENT_SECRET || '';
const INTER_BASE          = 'cdpj.partners.bancointer.com.br';
const INTER_CERT          = process.env.INTER_CERT || ''; // conteúdo do .crt
const INTER_KEY           = process.env.INTER_KEY  || ''; // conteúdo do .key
const INTER_CONTA         = process.env.INTER_CONTA || ''; // número da conta corrente PJ

// Token cacheado por scope - ver interTokenCache em interGetToken

// Requisição mTLS para a API do Inter
// ── Banco Inter ─────────────────────────────────────────────────────────────────
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
const interTokenCache = {}; // cache por scope
const interTokenPromise = {}; // promise em voo por scope (evita "thundering herd" de auth)

// Obtém token OAuth2 do Banco Inter (cache por escopo). Escopos: extrato.read, cobranca.read, cobranca.write, etc.
async function interGetToken(scope) {
  const scopeKey = scope || 'extrato.read boleto-cobranca.read boleto-cobranca.write';
  const agora = Date.now();
  if (interTokenCache[scopeKey] && agora < interTokenCache[scopeKey].exp) {
    return interTokenCache[scopeKey].token;
  }
  // Se já há uma requisição de token em voo para este escopo, aguarda ela em vez de
  // disparar outra (evita várias chamadas paralelas pedirem token ao mesmo tempo,
  // o que o Inter rejeita retornando token vazio → "auth falhou").
  if (interTokenPromise[scopeKey]) {
    return interTokenPromise[scopeKey];
  }
  interTokenPromise[scopeKey] = (async () => {
    const body = new URLSearchParams({
      client_id:     INTER_CLIENT_ID,
      client_secret: INTER_CLIENT_SECRET,
      grant_type:    'client_credentials',
      scope:         scopeKey
    }).toString();
    // Tentar até 3 vezes (o Inter às vezes rejeita sob carga)
    let ultimoErro = '';
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const r = await interReq('/oauth/v2/token', 'POST', body, null);
      if (r.data && r.data.access_token) {
        interTokenCache[scopeKey] = {
          token: r.data.access_token,
          exp:   Date.now() + (r.data.expires_in - 60) * 1000
        };
        return interTokenCache[scopeKey].token;
      }
      ultimoErro = JSON.stringify(r.data);
      await new Promise(res => setTimeout(res, 800 * (tentativa + 1))); // backoff
    }
    throw new Error('Inter auth falhou: ' + ultimoErro);
  })();
  try {
    return await interTokenPromise[scopeKey];
  } finally {
    delete interTokenPromise[scopeKey]; // libera para futuras renovações
  }
}

// Consultar saldo da conta


// Corrige boletos A_RECEBER (não pagos, venc. futuro) que estão marcados como PAGOS no site:
// move o valor de pagamentos[mes] para pagamentos_pendentes[mes]. Usado uma vez para regularizar
// boletos antigos (pré-bot) que foram importados como pagos. Modo dry-run lista sem alterar.
async function migrarBoletosFuturosParaPendente(dryRun) {
  const hoje = new Date(Date.now() - 3*60*60*1000);
  const hojeMes = hoje.toISOString().slice(0,7);
  // A janela dataInicial/dataFinal do Inter filtra por EMISSÃO. Boletos antigos foram
  // emitidos no passado (até ~18 meses atrás) com vencimento futuro. Buscamos em janelas
  // de ~90 dias para trás e para frente para capturar todos (o endpoint limita o intervalo).
  const janelas = [];
  for (let m = -18; m <= 12; m += 3) {
    const ini = new Date(hoje.getFullYear(), hoje.getMonth()+m, 1).toISOString().slice(0,10);
    const fim = new Date(hoje.getFullYear(), hoje.getMonth()+m+3, 0).toISOString().slice(0,10);
    janelas.push([ini, fim]);
  }

  let lista = [];
  const vistos = new Set();
  for (const [ini, fim] of janelas) {
    try {
      // Buscar SEM filtro de situação e filtrar A_RECEBER no código (o Inter usa A_RECEBER
      // para boletos emitidos aguardando pagamento, não A_VENCER).
      const r = await Promise.race([
        interCobranças(null, ini, fim),
        new Promise((_,rej) => setTimeout(() => rej(new Error('Timeout')), 25000))
      ]);
      const arr = r?.cobrancas || r?.content || (Array.isArray(r) ? r : []);
      arr.forEach(item => {
        const bc = item.cobranca || item;
        const id = bc.codigoSolicitacao || ((bc.seuNumero||'') + '|' + (bc.dataVencimento||''));
        if (!vistos.has(id)) { vistos.add(id); lista.push(item); }
      });
    } catch(e) { console.log('[migrar] janela ' + ini + ' falhou:', e.message); }
  }

  // Contagem por situação para diagnóstico
  const porSituacao = {};
  lista.forEach(item => { const s=(item.cobranca||item).situacao||'?'; porSituacao[s]=(porSituacao[s]||0)+1; });
  console.log('[migrar] total coletado:', lista.length, '| situações:', JSON.stringify(porSituacao));
  if (!lista.length) return 'ℹ️ Nenhum boleto retornado pelo Inter nas janelas de emissão (-18 a +12 meses).';

  const dados = await getDados();
  const alteracoes = []; // {aluno, mes, valor}
  const naoIdentificados = [];

  let diagAVencer = 0, diagComMes = 0, diagPagoNoSite = 0;
  for (const item of lista) {
    const bc = item.cobranca || item;
    if ((bc.situacao || '') !== 'A_RECEBER') continue; // só não pagos (Inter usa A_RECEBER, não A_VENCER)
    diagAVencer++;
    const psn = parseSeuNumero(bc.seuNumero);
    const venc = bc.dataVencimento || '';
    const mes = psn.mes || venc.slice(0,7);
    const valor = parseFloat(bc.valorNominal || 0);
    if (!psn.alunoId || !mes || !valor) { naoIdentificados.push((bc.seuNumero||'?') + ' (' + (bc.pagador?.nome||'?') + ')'); continue; }
    diagComMes++;

    const aluno = dados.alunos.find(a => a.id === psn.alunoId);
    if (!aluno) { naoIdentificados.push((bc.seuNumero||'?') + ' - aluno ' + psn.alunoId + ' não encontrado'); continue; }

    const pags = typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos||'{}'):(aluno.pagamentos||{});
    // Só corrigir se estiver marcado como PAGO (é o erro que queremos consertar)
    if (!(pags[mes] > 0)) continue;
    diagPagoNoSite++;

    alteracoes.push({ aluno, mes, valor: pags[mes] });
  }

  console.log('[migrar] diag — A_RECEBER:', diagAVencer, '| com mês/id:', diagComMes, '| pagos no site:', diagPagoNoSite, '| não ident.:', naoIdentificados.length);

  if (!alteracoes.length) {
    return '✅ Nenhuma correção a fazer.\n\n' +
      '📊 Diagnóstico:\n' +
      '• Boletos A_RECEBER no Inter: ' + diagAVencer + '\n' +
      '• Com aluno+mês identificados: ' + diagComMes + '\n' +
      '• Desses, marcados como pagos no site: ' + diagPagoNoSite + '\n' +
      (naoIdentificados.length ? '• Não identificados: ' + naoIdentificados.length + '\n   ' + naoIdentificados.slice(0,8).join('\n   ') + '\n' : '') +
      (diagAVencer === 0 ? '\n⚠️ Nenhum boleto com situação A_RECEBER.\nSituações encontradas: ' + JSON.stringify(porSituacao) : '');
  }

  // Modo dry-run: apenas listar o que seria feito
  if (dryRun) {
    const totalValor = alteracoes.reduce((s,x) => s + (x.valor||0), 0);
    // Total por mês para conferência
    const porMes = {};
    alteracoes.forEach(x => { porMes[x.mes] = (porMes[x.mes]||0) + x.valor; });
    const resumoMes = Object.keys(porMes).sort().map(m =>
      '   ' + m + ': ' + brl(porMes[m]) + ' (' + alteracoes.filter(x=>x.mes===m).length + ')'
    ).join('\n');
    const linhas = alteracoes.slice(0,30).map(x =>
      '• ' + x.aluno.nome.split(' ').slice(0,2).join(' ') + ' — ' + x.mes + ' (' + brl(x.valor) + ')'
    ).join('\n');
    return '🔍 *Prévia da correção* (' + alteracoes.length + ' boleto(s))\n\n' + linhas +
      (alteracoes.length>30 ? '\n_...e mais ' + (alteracoes.length-30) + '_' : '') +
      '\n\n📊 *Total por mês:*\n' + resumoMes +
      '\n\n💰 *Total geral: ' + brl(totalValor) + '* (' + alteracoes.length + ' boletos)' +
      '\n\n_Estes estão como PAGOS mas estão a receber (não pagos) no Inter._\n' +
      'Para aplicar a correção, envie: *confirmar correcao boletos*';
  }

  // Aplicar: mover pago → pendente
  let ok = 0, erros = 0;
  // Agrupar por aluno para um único patch por aluno
  const porAluno = {};
  alteracoes.forEach(x => {
    if (!porAluno[x.aluno.id]) porAluno[x.aluno.id] = { aluno: x.aluno, meses: [] };
    porAluno[x.aluno.id].meses.push({ mes: x.mes, valor: x.valor });
  });

  for (const g of Object.values(porAluno)) {
    try {
      const a = g.aluno;
      const pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
      const pend = typeof a.pagamentos_pendentes==='string'?JSON.parse(a.pagamentos_pendentes||'{}'):(a.pagamentos_pendentes||{});
      const hist = a.historico_alteracoes || [];
      g.meses.forEach(m => {
        pend[m.mes] = m.valor;   // marca como aguardando
        delete pags[m.mes];      // remove o "pago" indevido
        hist.push({ data: hoje.toLocaleDateString('pt-BR'), tipo: 'correcao',
          desc: 'Boleto ' + m.mes + ' reclassificado de pago→pendente (a receber no Inter): ' + brl(m.valor) });
      });
      await sbPatch('alunos', 'id=eq.' + a.id, {
        pagamentos: pags, pagamentos_pendentes: pend, historico_alteracoes: hist
      });
      ok += g.meses.length;
    } catch(e) {
      erros += g.meses.length;
      console.error('[migrar-boletos] erro aluno ' + g.aluno.id + ':', e.message);
    }
  }

  return '✅ *Correção aplicada!*\n\n' +
    ok + ' boleto(s) movidos de PAGO → aguardando.\n' +
    (erros ? '⚠️ ' + erros + ' com erro (ver log).\n' : '') +
    '\n_Recarregue o site para ver as mudanças._';
}

// Extrai { alunoId, mes } de um seuNumero de boleto Inter.
// Formatos suportados:
//  - 'LCA-{id}-{YYYY-MM}'  → boletos emitidos pelo bot (id + mês)
//  - '{numero}'            → boletos antigos (pré-bot): o seuNumero é o próprio ID do aluno (coluna # da aba Alunos)

// Retorna mensagem de ambiguidade se encontrarAluno retornou array, ou null se ok.
function ambiguidade(aluno, nomeBuscado) {
  if (!Array.isArray(aluno)) return null;
  return '⚠️ Há ' + aluno.length + ' alunos ativos com esse nome. Especifique o nome completo:\n' +
    aluno.map((a,i) => (i+1) + '. ' + a.nome + ' (id ' + a.id + ')').join('\n');
}
// Retorna { alunoId: number|null, mes: string|null }.
function parseSeuNumero(seuNum) {
  const sn = String(seuNum || '').trim();
  // Formato antigo: LCA-{id}-{YYYY-MM}
  const mLCA = sn.match(/^LCA-(\d+)-(\d{4}-\d{2})$/);
  if (mLCA) return { alunoId: parseInt(mLCA[1]), mes: mLCA[2] };
  // Formato novo compacto: LCA-{id}-{YYMM} (cabe em 15 chars mesmo com id grande)
  const mLCAc = sn.match(/^LCA-(\d+)-(\d{2})(\d{2})$/);
  if (mLCAc) return { alunoId: parseInt(mLCAc[1]), mes: '20' + mLCAc[2] + '-' + mLCAc[3] };
  // Cobrança excepcional: LCA-{id}-EXC...  (sem mês fixo)
  const mEXC = sn.match(/^LCA-(\d+)-EXC/);
  if (mEXC) return { alunoId: parseInt(mEXC[1]), mes: null };
  // Número puro = ID do aluno (boleto antigo). Sem mês embutido — será inferido pelo vencimento.
  if (/^\d+$/.test(sn)) return { alunoId: parseInt(sn), mes: null };
  return { alunoId: null, mes: null };
}

// Gera seuNumero no formato original LCA-{id}-{YYYY-MM}, com proteção de 15 chars
// caso o id cresça muito no futuro (o Inter rejeita seuNumero > 15 chars).
function gerarSeuNumero(alunoId, mesYYYYMM) {
  const sn = 'LCA-' + alunoId + '-' + (mesYYYYMM || '');
  if (sn.length <= 15) return sn;
  // Fallback compacto só se necessário (id muito grande): LCA-{id}-{YYMM}
  const m = String(mesYYYYMM||'').match(/^(\d{4})-(\d{2})$/);
  if (m) return ('LCA-' + alunoId + '-' + m[1].slice(2) + m[2]).slice(0,15);
  return sn.slice(0,15);
}

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
  // Tentar extrato enriquecido primeiro (mais campos, incluindo nome pagador quando disponível)
  const r = await interReq(
    '/banking/v2/extrato/enriquecido?dataInicio=' + dataInicio + '&dataFim=' + dataFim,
    'GET', null, token
  );
  if (r.status >= 200 && r.status < 300) return r.data;
  // Fallback: extrato simples
  const r2 = await interReq(
    '/banking/v2/extrato?dataInicio=' + dataInicio + '&dataFim=' + dataFim,
    'GET', null, token
  );
  if (r2.status >= 200 && r2.status < 300) return r2.data;
  // Ambas falharam → retorna null para o chamador distinguir FALHA de extrato vazio
  console.error('[interExtrato] falha: status', r.status, '/', r2.status);
  return null;
}

// Listar cobranças (boletos) por período
async function interCobranças(situacao, dataInicio, dataFim) {
  const token = await interGetToken('boleto-cobranca.read');
  // A API do Inter pagina os resultados (padrão ~100/página). Sem paginar, boletos além da
  // página 1 são perdidos (ex: bloco com muitos boletos no mês → julho do Vinicius sumia).
  let todas = [];
  let pagina = 0;
  const MAX_PAGINAS = 20; // proteção contra loop infinito
  while (pagina < MAX_PAGINAS) {
    const params = new URLSearchParams({
      dataInicial: dataInicio,
      dataFinal:   dataFim,
      itensPorPagina: '100',
      paginaAtual: String(pagina),
      ...(situacao ? { situacao } : {})
    });
    const r = await interReq('/cobranca/v3/cobrancas?' + params.toString(), 'GET', null, token);
    const d = r.data || {};
    const lote = d.cobrancas || [];
    todas = todas.concat(lote);
    // Critério de parada: última página, ou lote menor que o tamanho de página
    const totalPaginas = d.totalPaginas ?? d.paginacao?.totalPaginas;
    if (totalPaginas != null) {
      if (pagina >= (totalPaginas - 1)) break;
    } else if (lote.length < 100) {
      break;
    }
    pagina++;
  }
  return { cobrancas: todas };
}

// Busca robusta de cobranças varrendo janelas de EMISSÃO de -18 a +12 meses (passo 3 meses).
// É a estratégia comprovada que captura TODOS os boletos, inclusive de vencimento futuro
// (ex: planos emitidos antecipadamente). Dedup por codigoSolicitacao ou seuNumero+vencimento.
// Opções: { situacao, mesesAtras=18, mesesFrente=12, passo=3, timeoutMs=25000 }.
async function interCobrancasRobusto(opts) {
  opts = opts || {};
  const situacao = opts.situacao || null;
  const mesesAtras = opts.mesesAtras != null ? opts.mesesAtras : 18;
  const mesesFrente = opts.mesesFrente != null ? opts.mesesFrente : 12;
  const passo = opts.passo || 3;
  const timeoutMs = opts.timeoutMs || 25000;
  const hoje = new Date(Date.now() - 3*60*60*1000);
  const janelas = [];
  for (let m = -mesesAtras; m <= mesesFrente; m += passo) {
    const ini = new Date(hoje.getFullYear(), hoje.getMonth()+m, 1).toISOString().slice(0,10);
    const fim = new Date(hoje.getFullYear(), hoje.getMonth()+m+passo, 0).toISOString().slice(0,10);
    janelas.push([ini, fim]);
  }
  const vistos = new Set();
  const lista = [];
  for (const [ini, fim] of janelas) {
    try {
      const r = await Promise.race([
        interCobranças(situacao, ini, fim),
        new Promise((_,rej) => setTimeout(() => rej(new Error('Timeout')), timeoutMs))
      ]);
      const arr = r?.cobrancas || r?.content || (Array.isArray(r) ? r : []);
      arr.forEach(item => {
        const bc = item.cobranca || item;
        const id = bc.codigoSolicitacao || ((bc.seuNumero||'') + '|' + (bc.dataVencimento||''));
        if (vistos.has(id)) return;
        vistos.add(id);
        lista.push(item);
      });
    } catch(e) { console.log('[interCobrancasRobusto] janela ' + ini + ' falhou:', e.message); }
  }
  return { cobrancas: lista };
}

// Emitir boleto de cobrança
// Valida o dígito verificador do CPF (o Inter rejeita CPF inválido com "Dados inválidos").
function cpfValido(cpf) {
  cpf = String(cpf||'').replace(/\D/g,'');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let s = 0;
  for (let i=0;i<9;i++) s += parseInt(cpf[i])*(10-i);
  let d1 = (s*10)%11; if (d1===10) d1=0;
  if (d1 !== parseInt(cpf[9])) return false;
  s = 0;
  for (let i=0;i<10;i++) s += parseInt(cpf[i])*(11-i);
  let d2 = (s*10)%11; if (d2===10) d2=0;
  return d2 === parseInt(cpf[10]);
}

async function interEmitirBoleto(dados) {
  // dados: { valor, vencimento, nomePagador, cpfCnpj, email, descricao }
  const token = await interGetToken('boleto-cobranca.write');
  // Sanitizar campos que o Inter valida (evita "Dados inválidos"):
  const cpfLimpo = (dados.cpfCnpj||'').replace(/\D/g,'');
  // CEP: precisa de 8 dígitos e não pode ser tudo zero. Fallback: CEP válido do Rio (Flamengo).
  let cepLimpo = (dados.cep||'').replace(/\D/g,'').slice(0,8);
  if (cepLimpo.length !== 8 || /^0+$/.test(cepLimpo)) cepLimpo = '22220000';
  // Número: só dígitos ou "S/N". Endereço/nome sem caracteres problemáticos.
  let numeroLimpo = String(dados.numero||'').replace(/[^0-9A-Za-z\/ ]/g,'').trim() || 'S/N';
  if (numeroLimpo.length > 10) numeroLimpo = numeroLimpo.slice(0,10);
  const enderecoLimpo = String(dados.endereco||'Nao informado').replace(/[^0-9A-Za-zÀ-ÿ.,\/ -]/g,'').trim().slice(0,90) || 'Nao informado';
  const cidadeLimpa = String(dados.cidade||'Rio de Janeiro').replace(/[^0-9A-Za-zÀ-ÿ. -]/g,'').trim().slice(0,60) || 'Rio de Janeiro';
  const ufLimpo = String(dados.uf||'RJ').replace(/[^A-Za-z]/g,'').trim().toUpperCase().slice(0,2) || 'RJ';
  const nomeLimpo = String(dados.nomePagador||'').replace(/[^0-9A-Za-zÀ-ÿ. -]/g,'').trim().slice(0,100);
  const valorNum = Math.round((parseFloat(dados.valor)||0)*100)/100;
  const body = {
    seuNumero:    (dados.seuNumero || ('LCA-' + Date.now())).slice(0,15),
    valorNominal: valorNum,
    dataVencimento: dados.vencimento, // YYYY-MM-DD
    numDiasAgenda: 30,
    pagador: {
      cpfCnpj:    cpfLimpo,
      tipoPessoa: cpfLimpo.length === 11 ? 'FISICA' : 'JURIDICA',
      nome:       nomeLimpo,
      email:      dados.email || undefined,
      endereco:   enderecoLimpo,
      cidade:     cidadeLimpa,
      uf:         ufLimpo,
      cep:        cepLimpo,
      numero:     numeroLimpo,
      complemento: dados.complemento ? String(dados.complemento).replace(/[^0-9A-Za-zÀ-ÿ.,\/ -]/g,'').slice(0,30) : undefined,
      bairro: dados.bairro ? String(dados.bairro).replace(/[^0-9A-Za-zÀ-ÿ. -]/g,'').slice(0,40) : undefined
    },
    mensagem: {
      linha1: (dados.descricao || 'Mensalidade Pilates LCA Studio').slice(0,78),
      linha2: ('Ref: ' + (dados.referencia || new Date().toLocaleDateString('pt-BR'))).slice(0,78)
    }
  };
  const r = await interReq('/cobranca/v3/cobrancas', 'POST', body, token, {
    'x-id-idempotente': require('crypto').randomUUID()
  });
  // Se o Inter rejeitou, logar corpo enviado E resposta completa para diagnóstico definitivo
  if (r.status < 200 || r.status >= 300) {
    console.error('[interEmitirBoleto] REJEICAO Inter status', r.status);
    console.error('[interEmitirBoleto] BODY ENVIADO:', JSON.stringify(body));
    console.error('[interEmitirBoleto] RESPOSTA INTER:', JSON.stringify(r.data||{}));
  }
  return r.data;
}

// Cancela um boleto/cobrança no Inter pelo código de solicitação.
async function interCancelarBoleto(codigoSolicitacao) {
  if (!codigoSolicitacao) return null;
  const token = await interGetToken();
  const r = await interReq('/cobranca/v3/cobrancas/' + codigoSolicitacao + '/cancelar', 'POST',
    { motivoCancelamento: 'PAGAMENTO_EM_OUTRA_FORMA' }, token);
  return r;
}

// Grava registro de boleto emitido na tabela 'boletos' do Supabase (controle local de cobranças).
async function gravarBoleto(alunoId, mes, codigoSolicitacao, seuNumero, valor, vencimento) {
  try {
    await sbPost('boletos', {
      aluno_id: alunoId, mes,
      codigo_solicitacao: codigoSolicitacao,
      seu_numero: seuNumero, valor, vencimento,
      status: 'aberto', criado_em: new Date().toISOString()
    });
    await logOp('boleto_emitido', seuNumero + ' - vence ' + vencimento, alunoId, valor, mes, {codigoSolicitacao});
  } catch(e) {
    console.error('[gravarBoleto] erro:', e.message);
  }
}

// Busca e cancela no Inter o boleto a receber de um aluno em um mês específico (usado em alteração/rescisão de plano).
async function cancelarBoletoPorMes(alunoId, mes) {
  try {
    const r = await sbGet('boletos', 'aluno_id=eq.' + alunoId + '&mes=eq.' + mes + '&status=eq.aberto&select=id,codigo_solicitacao');
    const boletos = Array.isArray(r) ? r : (r?.data || []);
    for (const b of boletos) {
      if (b.codigo_solicitacao) {
        await interCancelarBoleto(b.codigo_solicitacao);
        await sbPatch('boletos', 'id=eq.' + b.id, { status: 'cancelado', cancelado_em: new Date().toISOString() });
        console.log('[cancelarBoleto] aluno=' + alunoId + ' mes=' + mes + ' cod=' + b.codigo_solicitacao);
      }
    }
    return boletos.length;
  } catch(e) {
    console.error('[cancelarBoletoPorMes] erro:', e.message);
    return 0;
  }
}

// ── HTTP genérico ───────────────────────────────────────────────────────────────
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

// ── Telegram ────────────────────────────────────────────────────────────────────
async function tgSend(chatId, text) {
  const r = await req('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage',
    'POST', { 'Content-Type': 'application/json' },
    { chat_id: chatId, text, parse_mode: 'Markdown' });
  // Telegram rejeita Markdown malformado (400 can't parse entities) — reenviar sem formatação
  if (r && r.ok === false) {
    console.log('[tgSend] Markdown rejeitado (' + (r.description||'').slice(0,60) + '), reenviando sem parse_mode');
    return req('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage',
      'POST', { 'Content-Type': 'application/json' },
      { chat_id: chatId, text });
  }
  return r;
}

// Envia um Buffer PDF como documento no Telegram via multipart/form-data.
async function tgSendPDFBuffer(chatId, pdfBuffer, filename, caption) {
  const boundary = '----TGBoundary' + Date.now();
  const safeFilename = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const parts = [
    '--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + chatId,
    '--' + boundary + '\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nMarkdown',
    '--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + caption||'',
    '--' + boundary + '\r\nContent-Disposition: form-data; name="document"; filename="' + safeFilename + '"\r\nContent-Type: application/pdf\r\n\r\n'
  ];
  const header = Buffer.from(parts.join('\r\n'));
  const footer = Buffer.from('\r\n--' + boundary + '--\r\n');
  const body = Buffer.concat([header, pdfBuffer, footer]);
  return new Promise((resolve, reject) => {
    const r = require('https').request({
      hostname: 'api.telegram.org', port: 443,
      path: '/bot' + TELEGRAM_TOKEN + '/sendDocument',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve(d);} }); });
    r.on('error', reject); r.write(body); r.end();
  });
}

// Lê um arquivo PDF do disco e envia no Telegram (wrapper de tgSendPDFBuffer).
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
    '--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + chatId,
    '--' + boundary + '\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nMarkdown',
    '--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + caption||'',
    '--' + boundary + '\r\nContent-Disposition: form-data; name="document"; filename="' + safeFilename + '"\r\nContent-Type: application/pdf\r\n\r\n'
  ];

  const header = Buffer.from(parts.join('\r\n'));
  const footer = Buffer.from('\r\n--' + boundary + '--\r\n');
  const body = Buffer.concat([header, pdfBuffer, footer]);

  return new Promise((resolve, reject) => {
    const r = require('https').request({
      hostname: 'api.telegram.org', port: 443,
      path: '/bot' + TELEGRAM_TOKEN + '/sendDocument',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
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
// ── Polling ──────────────────────────────────────────────────────────────────────
function tgUpdates(offset) {
  return req('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getUpdates?offset=' + offset + '&timeout=25', 'GET', {}, null, 35000);
}

// ── Supabase ─────────────────────────────────────────────────────────────────────
function sbHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json', Prefer: 'return=representation' };
}
const sbGet   = (t, q) => req(SUPABASE_URL+'/rest/v1/'+t+'?'+(q||''), 'GET', sbHeaders(), null);
const sbPost  = (t, b) => req(SUPABASE_URL+'/rest/v1/'+t, 'POST', sbHeaders(), b);
const sbPatch = (t, q, b) => req(SUPABASE_URL+'/rest/v1/'+t+'?'+q, 'PATCH', sbHeaders(), b);
const sbDelete= (t, q) => req(SUPABASE_URL+'/rest/v1/'+t+'?'+q, 'DELETE', sbHeaders(), null);

// ── Log de operações ────────────────────────────────────────────────────────────
// Retorna datetime atual em BRT (UTC-3) no formato ISO
function nowBRT() {
  return new Date(Date.now() - 3*60*60*1000).toISOString().replace('Z', '-03:00');
}


// Busca aluno por id ou nome — prioriza ativos quando há duplicidade de nome
function encontrarAluno(dados, p) {
  if (p?.aluno_id) return dados.alunos.find(a => a.id === p.aluno_id);
  if (!p?.aluno_nome) return null;
  const preps = ['de','da','do','das','dos','e'];
  const termo = p.aluno_nome.toLowerCase().trim();
  const termoPartes = termo.split(/\s+/).filter(x => !preps.includes(x));

  // 1) Match exato do nome completo
  let m = dados.alunos.filter(a => a.nome.toLowerCase() === termo);
  // 2) Nome do aluno começa com o termo (ex: "ana luiza" → "Ana Luiza Santoro")
  if (!m.length) m = dados.alunos.filter(a => a.nome.toLowerCase().startsWith(termo));
  // 3) Substring direta
  if (!m.length) m = dados.alunos.filter(a => a.nome.toLowerCase().includes(termo));
  // 4) Todas as palavras do termo presentes no nome (ordem livre). Quando o termo tem 2+ palavras,
  //    isso evita casar "luiza" sozinho com a aluna errada — exige Ana E Luiza.
  if (!m.length && termoPartes.length) {
    m = dados.alunos.filter(a => {
      const partesAluno = a.nome.toLowerCase().split(/\s+/).filter(x => !preps.includes(x));
      return termoPartes.every(t => partesAluno.includes(t));
    });
  }
  if (!m.length) return null;

  // Desempate: se o termo tem 2+ palavras, preferir quem casa TODAS as palavras do termo
  if (termoPartes.length >= 2 && m.length > 1) {
    const exatos = m.filter(a => {
      const partesAluno = a.nome.toLowerCase().split(/\s+/).filter(x => !preps.includes(x));
      return termoPartes.every(t => partesAluno.includes(t));
    });
    if (exatos.length) m = exatos;
  }
  // Preferir ativo. Se ainda há ambiguidade entre ativos, retorna array para o chamador tratar.
  const ativos = m.filter(a => a.ativo === 'SIM');
  if (ativos.length === 1) return ativos[0];
  if (ativos.length > 1) return ativos; // ambiguidade — chamador deve pedir confirmação
  return m[0];
}

// Registra uma operação na tabela 'log_inter' do Supabase (auditoria exibida na aba API Inter do site).
async function logOp(tipo, descricao, alunoId, valor, mes, extra) {
  try {
    await sbPost('log_operacoes', {
      tipo,
      descricao,
      aluno_id: alunoId || null,
      valor: valor || null,
      mes: mes || null,
      extra: extra ? JSON.stringify(extra) : null,
      origem: 'bot',
      criado_em: new Date().toISOString()
    });
  } catch(e) {
    console.error('[logOp] erro:', e.message);
  }
}

// ── IA / Gemini ──────────────────────────────────────────────────────────────────
function aiWithTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout '+ms+'ms')), ms))
  ]);
}

// Chama a API Gemini com um prompt e retorna o texto da resposta. Timeout interno.
async function ai(prompt) {
  const models = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
  for (const model of models) {
    try {
      const r = await aiWithTimeout(req(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + GEMINI_KEY,
        'POST', { 'Content-Type': 'application/json' },
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 800 } },
        8000
      ), 9000);
      if (r?.candidates?.[0]?.content) return r.candidates[0].content.parts[0].text.trim();
      if (r?.error?.code === 503 || r?.error?.code === 429) { console.log(model+' indisponível ('+r.error.code+')'); continue; }
      if (r?.error) { console.error('Gemini erro em '+model+':', r.error.code, r.error.message?.slice(0,60)); continue; }
      console.log(model+' sem candidatos - resposta:', JSON.stringify(r).slice(0,80));
    } catch(e) {
      console.error('Gemini '+model+':', e.message);
      if (e.message.includes('timeout')) continue;
    }
  }
  return null;
}

// Chama o Gemini esperando JSON; faz parse defensivo extraindo o objeto mesmo com texto ao redor.
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

// ── Dados do Supabase ───────────────────────────────────────────────────────────

// Calcula a data de vencimento do plano de um aluno (espelha calcVencimentoPlano do site).
// Prioridade: 1) última renovação no histórico (data + dia_venc precisos);
//             2) último mês com valor (pago/pendente) + duração como fallback.
function calcVencimentoPlanoBot(a) {
  const DUR = { mensal:1, trimestral:3, semestral:6 };
  const dur = DUR[a.tipo_plano] || 1;
  const hist = a.historico_alteracoes || [];
  const renovacoes = hist.filter(h => (h.tipo==='renovacao'||h.tipo==='renovacao_antecipada') && h.data && h.dia_venc);
  if (renovacoes.length) {
    const ult = renovacoes[renovacoes.length-1];
    const dp = ult.data.split('/');
    const anoRen = parseInt(dp[2]), mesRen = parseInt(dp[1]), diaRen = parseInt(dp[0]);
    const diaVenc = ult.dia_venc || a.dia_vencimento || 1;
    let mesInicio = mesRen, anoInicio = anoRen;
    if (diaRen > diaVenc) { mesInicio++; if (mesInicio>12){mesInicio=1;anoInicio++;} }
    let mesVenc = mesInicio + dur, anoVenc = anoInicio;
    while (mesVenc > 12) { mesVenc -= 12; anoVenc++; }
    return new Date(anoVenc, mesVenc-1, diaVenc);
  }
  // Fallback: último mês com valor (pago ou pendente) + 1 mês no dia de vencimento
  const pend = typeof a.pagamentos_pendentes==='string'?JSON.parse(a.pagamentos_pendentes||'{}'):(a.pagamentos_pendentes||{});
  const pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
  const meses = [...new Set([
    ...Object.keys(pend).filter(k=>(pend[k]||0)>0),
    ...Object.keys(pags).filter(k=>(pags[k]||0)>0)
  ])].sort();
  if (!meses.length) return null;
  const lp = meses[meses.length-1].split('-');
  const diaV = parseInt(a.dia_vencimento||10);
  return new Date(parseInt(lp[0]), parseInt(lp[1]), diaV);
}

async function getDados() {
  const [ra, rc, rk] = await Promise.all([
    sbGet('alunos', 'select=id,nome,ativo,cpf,email,telefone,tipo_plano,vezes_semana,forma_pagamento,dia_vencimento,professora,prof_secundaria,aulas_prof,pagamentos,pagamentos_pendentes,pagamentos_rescisao,data_matricula,historico_alteracoes,valor_referencia,logradouro,numero,complemento,bairro,cidade,cep,endereco,nascimento,aniversario,sexo'),
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
  // Planos: busca tabela de planos para valores atualizados (fallback silencioso)
  let planos = null;
  try {
    const rpl = await sbGet('changes', 'select=data&id=eq.1');
    if (Array.isArray(rpl) && rpl[0]?.data) {
      const chData = typeof rpl[0].data === 'string' ? JSON.parse(rpl[0].data) : rpl[0].data;
      if (chData && chData.planos && typeof chData.planos === 'object') planos = chData.planos;
    }
  } catch(e) {}
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
    planos:  planos,
    changes: changes
  };
}

// Persiste alterações de agenda/checkins/planos na tabela 'changes' (id=1) do Supabase via upsert.
async function saveChanges(ch) {
  try {
    await req(SUPABASE_URL+'/rest/v1/changes', 'POST',
      { ...sbHeaders(), Prefer: 'resolution=merge-duplicates' }, { id: 1, data: ch });
  } catch(e) { console.error('saveChanges erro:', e.message); }
}

// ── Utilitários ─────────────────────────────────────────────────────────────────
function brl(v) { return 'R$ ' + Math.abs(Number(v)||0).toFixed(2).replace('.', ','); }

// ── Contexto para a IA ─────────────────────────────────────────────────────────
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
  // A receber no mês = soma de pagamentos_pendentes[mes] (boletos emitidos aguardando pagamento)
  let aReceberMes = 0, nAReceber = 0;
  dados.alunos.forEach(a => {
    const pend = typeof a.pagamentos_pendentes==='string'?JSON.parse(a.pagamentos_pendentes||'{}'):(a.pagamentos_pendentes||{});
    if (pend[mes] > 0) { aReceberMes += pend[mes]; nAReceber++; }
  });
  const receitaEsperada = receitaMes + aReceberMes;          // se todos os pendentes pagarem
  const resultadoEsperado = receitaEsperada; // resultado calculado abaixo após custos/prof
  // Inadimplentes = ativos que não pagaram E cujo dia de vencimento já passou neste mês
  const hojeBot = new Date();
  const diaHoje = hojeBot.getDate();
  const mesAtualBot = hojeBot.getFullYear() + '-' + String(hojeBot.getMonth()+1).padStart(2,'0');
  // Aluno trimestral/semestral cujo ciclo terminou e não renovou NÃO é inadimplente (está "a renovar")
  const DUR_INAD = { mensal:1, trimestral:3, semestral:6 };
  function cicloVencidoBot(a) {
    if (a.tipo_plano === 'mensal') return false;
    const venc = calcVencimentoPlanoBot(a);
    if (!venc) return false;
    return venc < hojeBot; // ciclo encerrado antes de hoje (sem renovação)
  }
  const inadimplentes = ativos.filter(a => {
    const pag = pagMes.find(p => p.id === a.id);
    if (pag && pag.pagou) return false; // Já pagou
    if (cicloVencidoBot(a)) return false; // Plano encerrado sem renovação → não é inadimplência
    // Só considera inadimplente se o dia de vencimento já passou
    const diaVenc = parseInt(a.dia_vencimento || 10);
    return diaHoje >= diaVenc;
  });

  // Custos do mês
  const custosMes = dados.custos.filter(c => c.mes === mes);
  const totalCustos = custosMes.reduce((s, c) => s + (c.valor||0), 0);

  // Professoras - valores reais da tabela (fonte única de verdade)
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
  const planosVencendo = ativos
    .filter(a => a.tipo_plano === 'trimestral' || a.tipo_plano === 'semestral')
    .map(a => {
      const venc = calcVencimentoPlanoBot(a);
      if (!venc) return null;
      const dias = Math.round((venc-hojeTs)/86400000);
      return { nome: a.nome, plano: a.tipo_plano, dias,
        dataVenc: venc.toLocaleDateString('pt-BR'),
        diaVenc: String(venc.getDate()).padStart(2,'0'),
        mesVenc: String(venc.getMonth()+1).padStart(2,'0') };
    }).filter(p => p && p.dias >= -5 && p.dias <= 30)
    .sort((a,b) => a.dias-b.dias);

  console.log('Planos vencendo:', planosVencendo.length, '| Trim/Sem ativos:', ativos.filter(a=>a.tipo_plano==='trimestral'||a.tipo_plano==='semestral').length);
  dados._planosVencendo = planosVencendo; // cache

  return {
    hoje: new Date().toLocaleDateString('pt-BR'),
    mes,
    estudio: { totalAlunos: dados.alunos.length, ativos: ativos.length, inativos: inativos.length },
    financeiro: { receita: receitaMes, professoras: totalProf, custos: totalCustos, resultado,
      aReceber: aReceberMes, nAReceber: nAReceber,
      receitaEsperada: receitaEsperada,
      resultadoEsperado: receitaEsperada - totalProf - totalCustos,
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
    todosOsCustos: dados.custos.slice(0,20).map(c => ({ id: c.id, desc: c.descricao, valor: c.valor, mes: c.mes })),
    aniversariantes: (() => {
      const hoje2 = new Date();
      const dh2 = String(hoje2.getDate()).padStart(2,'0');
      const mh2 = String(hoje2.getMonth()+1).padStart(2,'0');
      const proximos = dados.alunos
        .filter(a => a.aniversario && a.aniversario.trim())
        .map(a => {
          const p = a.aniversario.split('/');
          const dia = parseInt(p[0]), mes2 = parseInt(p[1]);
          const hojeDia = hoje2.getDate(), hojeMes = hoje2.getMonth()+1;
          let diasFaltando = (mes2 - hojeMes)*30 + (dia - hojeDia);
          if (diasFaltando < 0) diasFaltando += 365;
          return { nome: a.nome, ativo: a.ativo, aniversario: a.aniversario, diasFaltando };
        })
        .sort((a,b) => a.diasFaltando - b.diasFaltando)
        .slice(0, 10);
      const hoje3 = proximos.filter(a => a.diasFaltando === 0);
      return { hoje: hoje3, proximos };
    })()
  };
}

// Intenções que alteram dados (precisam de execução estruturada)
const INTENCOES_ACAO = ['lancar_custo','lancar_aula','confirmar_pagamento','calcular_rescisao',
  'remover_custo','remover_custo_id','desfazer_pagamento','desfazer_aula','checkin','desfazer_checkin'];

// Chamada unificada: classifica E responde em uma só requisição
// ── Processamento com IA ────────────────────────────────────────────────────────
async function processarComIA(texto, dados, mes) {
  const ctx = buildContexto(dados, mes);

  // Detectar perguntas sobre aniversariantes diretamente
  if (/aniversar/i.test(texto)) {
    // Data em horário de Brasília (UTC-3)
    const hoje4 = new Date(Date.now() - 3*60*60*1000);
    const dh4 = String(hoje4.getDate()).padStart(2,'0');
    const mh4 = String(hoje4.getMonth()+1).padStart(2,'0');
    const anivHoje = dados.alunos.filter(a => (a.aniversario||'').indexOf(dh4+'/'+mh4) === 0);

    // Calcular dias faltando com datas reais (evita erros de aritmética simples)
    function diasParaAniv(anivStr) {
      const p = anivStr.split('/');
      const dia = parseInt(p[0]), mes3 = parseInt(p[1]);
      const ano = hoje4.getFullYear();
      let proximo = new Date(ano, mes3-1, dia);
      const hojeZero = new Date(hoje4.getFullYear(), hoje4.getMonth(), hoje4.getDate());
      if (proximo <= hojeZero) proximo = new Date(ano+1, mes3-1, dia);
      return Math.round((proximo - hojeZero) / 86400000);
    }

    const proximos2 = dados.alunos
      .filter(a => a.aniversario && a.aniversario.trim())
      .filter(a => (a.aniversario).indexOf(dh4+'/'+mh4) !== 0) // excluir hoje
      .map(a => {
        const df = diasParaAniv(a.aniversario);
        return { nome: a.nome, ativo: a.ativo === 'SIM', aniversario: a.aniversario, df };
      })
      .sort((a,b) => a.df - b.df)
      .slice(0, 5);

    let resp = '';
    if (anivHoje.length) {
      resp += '🎂 *Aniversariantes hoje (' + dh4 + '/' + mh4 + '):*\n';
      anivHoje.forEach(a => {
        resp += '• *' + a.nome + '* - ' + (a.ativo === 'SIM' ? '🟢 Ativa(o)' : '🔴 Inativa(o)') + ' - ' + (a.telefone||'sem telefone') + '\n';
      });
    } else {
      resp += 'Nenhum aniversariante hoje (' + dh4 + '/' + mh4 + ').\n';
    }
    if (proximos2.length) {
      resp += '\n📅 *Próximos aniversários:*\n';
      proximos2.forEach(a => {
        resp += '• *' + a.nome + '* - ' + a.aniversario + ' (em ' + a.df + ' dias) ' + (a.ativo ? '🟢' : '🔴') + '\n';
      });
    }
    return { tipo: 'consulta', resposta: resp };
  }

  // Detectar ações por palavras-chave (sem IA) - economiza cota
  const tL = texto.toLowerCase();
  // Saudação e ajuda - sem IA
  if (['oi','olá','ola','bom dia','boa tarde','boa noite'].some(k => tL.startsWith(k))) {
    return { tipo: 'saudacao' };
  }
  if (['ajuda','help','comando','como usar'].some(k => tL.includes(k))) {
    return { tipo: 'ajuda' };
  }

  // Comandos Inter - detecção direta por palavra-chave (sem IA)
  const temInter = tL.includes('inter') || tL.includes('banco') || tL.includes('conta');
  if (tL.includes('extrato') || tL.includes('movimentação') || tL.includes('transaç')) {
    if (tL.includes('debug') || tL.includes('cru') || tL.includes('json')) {
      return { tipo: 'acao', intencao: 'inter_extrato_debug', params: {} };
    }
    return { tipo: 'acao', intencao: 'inter_extrato', params: {} };
  }
  // Comando "resumo" sob demanda — mesma mensagem do resumo semanal
  if (tL === 'resumo' || tL === 'resumo semanal' || tL === 'resumo da semana') {
    return { tipo: 'acao', intencao: 'resumo_semanal', params: {} };
  }
  // Comando "backup" sob demanda
  if (tL === 'backup' || tL === 'fazer backup' || tL === 'exportar backup') {
    return { tipo: 'acao', intencao: 'backup_agora', params: {} };
  }
  // Verificar Pix recebidos agora (antecipa a rotina de 30 min)
  if (tL === 'pix' || tL === 'verificar pix' || tL === 'detectar pix' || tL === 'checar pix') {
    return { tipo: 'acao', intencao: 'verificar_pix', params: {} };
  }
  if (tL === 'detectar boletos' || tL === 'verificar boletos' || tL === 'checar boletos' || tL === 'baixar boletos') {
    return { tipo: 'acao', intencao: 'verificar_boletos_pagos', params: {} };
  }
  // Desfazer pagamento direto: "desfazer pagamento NOME MES" (evita a IA classificar como remover custo)
  if (tL.startsWith('desfazer pagamento ') || tL.startsWith('remover pagamento ') || tL.startsWith('apagar pagamento ')) {
    const resto = texto.replace(/^(desfazer|remover|apagar)\s+pagamento\s+/i, '').trim();
    // Extrair mês: YYYY-MM, MM/YYYY, ou nome por extenso
    const MESES_D = {janeiro:'01',fevereiro:'02','março':'03',marco:'03',abril:'04',maio:'05',junho:'06',julho:'07',agosto:'08',setembro:'09',outubro:'10',novembro:'11',dezembro:'12'};
    let mesAlvo = null, nomeParte = resto;
    const mYYYYMM = resto.match(/(\d{4})-(\d{2})/);
    const mMMYYYY = resto.match(/(\d{1,2})\/(\d{4})/);
    if (mYYYYMM) { mesAlvo = mYYYYMM[1] + '-' + mYYYYMM[2]; nomeParte = resto.replace(mYYYYMM[0], '').trim(); }
    else if (mMMYYYY) { mesAlvo = mMMYYYY[2] + '-' + String(mMMYYYY[1]).padStart(2,'0'); nomeParte = resto.replace(mMMYYYY[0], '').trim(); }
    else {
      for (const [nm, num] of Object.entries(MESES_D)) {
        if (tL.includes(nm)) { const anoM = (tL.match(/20\d{2}/)||[])[0] || String(new Date().getFullYear()); mesAlvo = anoM + '-' + num; nomeParte = resto.replace(new RegExp(nm,'i'),'').replace(/20\d{2}/,'').trim(); break; }
      }
    }
    if (nomeParte) {
      const alunoDesf = detectarAlunoNoTexto(dados, nomeParte.toLowerCase()) || encontrarAluno(dados, { aluno_nome: nomeParte });
      if (alunoDesf) {
        return { tipo: 'acao', intencao: 'desfazer_pagamento', params: { aluno_id: alunoDesf.id, aluno_nome: alunoDesf.nome, mes: mesAlvo } };
      }
    }
  }
  // Correção de boletos futuros marcados como pagos (prévia e confirmação)
  if (tL === 'corrigir boletos' || tL === 'corrigir boletos futuros' || tL === 'migrar pendentes') {
    return { tipo: 'acao', intencao: 'corrigir_boletos_preview', params: {} };
  }
  if (tL === 'confirmar correcao boletos' || tL === 'confirmar correção boletos') {
    return { tipo: 'acao', intencao: 'corrigir_boletos_aplicar', params: {} };
  }
  if (temInter && (tL.includes('saldo') || tL.includes('quanto tem'))) {
    return { tipo: 'acao', intencao: 'inter_saldo', params: {} };
  }

  // Confirmar compensação de cheque
  if (tL.includes('cheque') && (tL.includes('compensou') || tL.includes('compensado') || tL.includes('confirmar') || tL.includes('ok'))) {
    return { tipo: 'acao', intencao: 'confirmar_cheque', params: {} };
  }

  // Reenviar PDFs de boletos já emitidos
  if ((tL.includes('reenviar') || tL.includes('enviar') || tL.includes('mandar')) &&
      tL.includes('boleto')) {
    const palavrasIgnorar = ['reenviar','enviar','mandar','boleto','boletos','do','da','de','para','os','inter'];
    const MESES_NOMES = ['janeiro','fevereiro','março','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    // Extrair filtro ANTES de montar o nome (para não contaminar a busca do aluno)
    const filtroMes = tL.split(/\s+/).find(w => MESES_NOMES.includes(w)) || '';
    const filtroValMatch = tL.match(/\b(\d{3,6}(?:[,.]\d+)?)\b/);
    const filtroVal = filtroValMatch ? filtroValMatch[1] : '';
    const filtro = filtroMes || filtroVal;
    // Remover o filtro do texto antes de extrair o nome
    const tLsemFiltro = filtro ? tL.replace(filtro, '').replace(/\s+/g,' ').trim() : tL;
    const palavras = tLsemFiltro.split(/\s+/).filter(p => p.length > 2 && !palavrasIgnorar.includes(p));
    const nomeCandidato = palavras.join(' ');
    const alunoReenv = nomeCandidato ? encontrarAluno(dados, { aluno_nome: nomeCandidato }) : null;
    const paramsReenv = Array.isArray(alunoReenv)
      ? { aluno_nome: nomeCandidato, filtro }
      : (alunoReenv ? { aluno_id: alunoReenv.id, aluno_nome: alunoReenv.nome, filtro } : { filtro });
    return { tipo: 'acao', intencao: 'inter_reenviar_boletos', params: paramsReenv };
  }
  if ((tL.includes('emitir') || tL.includes('gerar')) && (tL.includes('plano') || tL.includes('boleto') || tL.includes('boletos')) &&
      !tL.includes('mensal') && !tL.includes('reenviar') && !tL.includes('cancelar')) {
    const palavrasIgnorar = ['emitir','gerar','boleto','boletos','plano','planos','do','da','de','para','inter'];
    const palavras = tL.split(/\s+/).filter(p => p.length > 2 && !palavrasIgnorar.includes(p));
    // Montar nome candidato e usar encontrarAluno (que trata ambiguidade)
    const nomeCandidato = palavras.join(' ');
    const alunoEncontrado = nomeCandidato ? encontrarAluno(dados, { aluno_nome: nomeCandidato }) : null;
    if (alunoEncontrado && (tL.includes('plano') || (!Array.isArray(alunoEncontrado) && ['trimestral','semestral'].includes(alunoEncontrado.tipo_plano)))) {
      // Se ambiguidade: não passa aluno_id, o handler vai pedir confirmação
      if (Array.isArray(alunoEncontrado)) {
        return { tipo: 'acao', intencao: 'inter_emitir_plano',
                 params: { aluno_nome: nomeCandidato } };
      }
      return { tipo: 'acao', intencao: 'inter_emitir_plano',
               params: { aluno_id: alunoEncontrado.id, aluno_nome: alunoEncontrado.nome } };
    }
  }
  // Boletos vencidos/atrasados — detectar independente de mencionar "inter"
  const temBoleto = tL.includes('boleto') || tL.includes('cobrança') || tL.includes('cobranca');
  const temVencido = tL.includes('vencido') || tL.includes('inadim') || tL.includes('atrasado') ||
    tL.includes('em aberto') || tL.includes('nao pago') || tL.includes('não pago') || tL.includes('pendente');
  if (temVencido && (temBoleto || temInter)) {
    return { tipo: 'acao', intencao: 'inter_boletos_vencidos', params: {} };
  }
  // Pergunta genérica sobre inadimplência (sem mencionar boleto)
  if (temVencido && (tL.includes('aluno') || tL.includes('pag') || tL.includes('devend'))) {
    return { tipo: 'acao', intencao: 'inter_boletos_vencidos', params: {} };
  }

// Tenta identificar um aluno mencionado em um texto livre.
// Prioriza match de nome composto (2 palavras) sobre primeiro nome isolado,
// evitando que "ana luiza" case com a aluna "Luiza". Retorna o aluno ou null.
function detectarAlunoNoTexto(dados, tL) {
  const preps = ['de','da','do','das','dos','e'];
  // 1) Tentar casar nome+sobrenome (2 primeiras palavras de cada aluno) presentes no texto
  let best = null, bestLen = 0;
  for (const a of dados.alunos) {
    const partes = a.nome.toLowerCase().split(/\s+/).filter(x => !preps.includes(x));
    if (partes.length >= 2) {
      const n1 = partes[0], n2 = partes[1];
      if (n1.length > 2 && n2.length > 2 && tL.includes(n1) && tL.includes(n2)) {
        // pontuação: comprimento combinado — nomes compostos mais específicos ganham
        const score = n1.length + n2.length;
        if (score > bestLen) { best = a; bestLen = score; }
      }
    }
  }
  if (best) return best;
  // 2) Fallback: primeiro nome isolado (>3 letras). Preferir aluno ativo.
  const porPrimeiro = dados.alunos.filter(a => {
    const p1 = a.nome.split(' ')[0].toLowerCase();
    return p1.length > 3 && tL.includes(p1);
  });
  if (porPrimeiro.length) return porPrimeiro.find(a => a.ativo === 'SIM') || porPrimeiro[0];
  return null;
}

  if (temBoleto && !tL.includes('emitir') && !tL.includes('gerar') && !tL.includes('criar')) {
    // Identificar aluno (prioriza nome composto: "ana luiza" não casa com "Luiza")
    const alunoMencB = detectarAlunoNoTexto(dados, tL);
    // Modo debug: mostra campos crus dos boletos do aluno (codigoSolicitacao, situacao, venc)
    if ((tL.includes('debug') || tL.includes('cru')) && alunoMencB) {
      return { tipo: 'acao', intencao: 'inter_boletos_debug', params: { aluno_id: alunoMencB.id, aluno_nome: alunoMencB.nome } };
    }
    // Só disparar sem "inter" se houver aluno mencionado — senão exige "inter" para não confundir
    if (alunoMencB || temInter) {
      return { tipo: 'acao', intencao: 'inter_boletos', params: alunoMencB ? { aluno_id: alunoMencB.id, aluno_nome: alunoMencB.nome } : {} };
    }
  }
  // Situação financeira de aluno específico (não intercepta "resumo financeiro" geral)
  if ((tL.includes('situação') || tL.includes('situacao') || tL.includes('financeira') || tL.includes('financeiro')) && !tL.includes('resumo') && !tL.includes('resultado')) {
    const alunoMencF = detectarAlunoNoTexto(dados, tL);
    if (alunoMencF) return { tipo: 'acao', intencao: 'consulta_aluno', params: { aluno_id: alunoMencF.id, aluno_nome: alunoMencF.nome } };
  }
  // Despedidas e respostas curtas não-acionáveis
  const despedidas = ['obrigado','obrigada','valeu','tchau','até','flw','ok','entendi','certo','legal','perfeito','ótimo','otimo','show','blz','beleza'];
  if (texto.length < 30 && despedidas.some(k => tL.includes(k))) {
    return { tipo: 'consulta', resposta: '😊 Disponível quando precisar!' };
  }

  // UMA chamada ao Gemini - classifica E responde/extrai tudo
  const ultimoValor = {};
  dados.alunos.forEach(function(a) {
    var pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
    var keys = Object.keys(pags).filter(function(k){return pags[k]>0;}).sort();
    if (keys.length) ultimoValor[a.nome] = pags[keys[keys.length-1]];
  });

  const prompt = 'Você é o assistente do LCA Studio de Pilates (Rio de Janeiro, ' + ctx.hoje + ').\n\n' +
    'DADOS (' + mes + '):\n' +
    'Ativos: ' + ctx.estudio.ativos + ' | Inadimplentes: ' + (ctx.inadimplentes.map(function(a){return a.nome;}).join(', ')||'Nenhum') + '\n' +
    'Receita: ' + brl(ctx.financeiro.receita) + ' | Professoras: ' + brl(ctx.financeiro.professoras) + ' | Custos: ' + brl(ctx.financeiro.custos) + ' | Resultado: ' + brl(ctx.financeiro.resultado) + '\n' +
    'A receber neste mes (boletos pendentes): ' + brl(ctx.financeiro.aReceber) + ' (' + ctx.financeiro.nAReceber + ' boletos) | Receita esperada se todos pagarem: ' + brl(ctx.financeiro.receitaEsperada) + ' | Resultado esperado: ' + brl(ctx.financeiro.resultadoEsperado) + '\n' +
    'Planos vencendo: ' + (ctx.planosVencendo.length?ctx.planosVencendo.map(function(p){return p.nome+' ('+p.plano+', dia '+p.diaVenc+'/'+p.mesVenc+', '+p.dias+' dias)';}).join(' | '):'Nenhum') + '\n' +
    'Custos lancados: ' + (ctx.custosMes.map(function(c){return c.desc+' '+brl(c.valor);}).join(', ')||'Nenhum') + '\n' +
    'Faltas frequentes: ' + (ctx.faltasFrequentes.join(', ')||'Nenhuma') + '\n' +
    'Professoras este mes: Leda ' + brl(ctx.financeiro.paramProf.retLeda) + ' fixo |\n' +
    'Monica ' + brl(ctx.financeiro.detalheProfessoras.monica) + ' (' + Math.round(ctx.financeiro.paramProf.pctMonica*100) + '% alunos dela) |\n' +
    'Kelly ' + brl(ctx.financeiro.detalheProfessoras.kelly) + ' (' + ctx.aulasKelly.reduce(function(s,k){return s+(k.horas||0);},0) + 'h x ' + brl(ctx.financeiro.paramProf.vhKelly) + ')\n' +
    'Ultimo pagamento por aluno: ' + JSON.stringify(ultimoValor) + '\n\n' +
    'REGRAS DE INTENCAO (siga rigorosamente):\n' +
    '- "saldo da conta/inter/banco", "quanto tem no banco" → inter_saldo\n' +
    '- "extrato", "movimentação da conta", "transações" → inter_extrato\n' +
    '- "resumo financeiro", "resultado do mes", "receita do estudio" → consulta\n' +
    '- "saldo" sem mencao a banco/conta/Inter → consulta sobre o estudio\n\n' +
    'MENSAGEM: "' + texto + '"\n\n' +
    'ESTILO DA RESPOSTA (quando for consulta, especialmente resumo financeiro):\n' +
    '- Use Markdown e emojis para deixar visual e fácil de ler no Telegram.\n' +
    '- Sugestão de emojis por seção: 📊 título/resumo, 👥 ativos, 🔴 inadimplentes, 💰 receita, 👩‍🏫 professoras, 💸 custos, ✅ ou 📈 resultado positivo / 📉 se negativo, 📥 a receber/boletos pendentes, 📅 planos vencendo, 🧾 custos lançados, ⚠️ faltas frequentes.\n' +
    '- Use *negrito* nos rótulos e valores em R$. Não exagere: 1 emoji por linha/seção, sem poluir.\n' +
    '- Mantenha os números exatamente como nos DADOS, sem inventar.\n\n' +
    'Retorne JSON (sem markdown):\n' +
    '{\n' +
    '  "tipo": "consulta" ou "acao",\n' +
    '  "resposta": "resposta em Markdown se consulta, null se acao",\n' +
    '  "intencao": null se consulta, ou lancar_custo/lancar_aula/confirmar_pagamento/calcular_rescisao/remover_custo/remover_custo_id/desfazer_pagamento/desfazer_aula/checkin/desfazer_checkin/inter_saldo/inter_extrato/inter_boletos/inter_boletos_vencidos/inter_emitir_boleto/inter_emitir_plano/inter_cancelar_boleto/inter_reenviar_boletos/confirmar_cheque/alterar_plano,\n' +
    '  "params": {\n' +
    '    "aluno_nome": string ou null,\n' +
    '    "valor": numero — PRIORIDADE ABSOLUTA: se o usuario digitou um numero no texto, use EXATAMENTE esse numero, mesmo que diferente do historico. Apenas se NENHUM numero foi digitado, use o ultimo pagamento do aluno. Ou null,\n' +
    '    "mes": "YYYY-MM" ou null (atual ' + mes + '),\n' +
    '    "categoria": string ou null,\n' +
    '    "descricao": string ou null,\n' +
    '    "professora": string ou null,\n' +
    '    "horas": numero ou null,\n' +
    '    "meses_utilizados": numero ou null,\n' +
    '    "data": "YYYY-MM-DD" ou null (hoje ' + new Date().toISOString().slice(0,10) + '),\n' +
    '    "hora": "HH:MM" ou null,\n' +
    '    "status_checkin": presente ou falta ou repos ou null,\n' +
    '    "custo_id": numero ou null\n' +
    '  }\n' +
    '}'

  const raw = await aiJSON(prompt);
  if (!raw) return { tipo: 'consulta', resposta: null };
  console.log('IA:', raw.tipo, raw.intencao||'consulta');
  return raw;
}

// ── Extração de parâmetros ──────────────────────────────────────────────────────
async function extrairParams(intencao, texto, dados) {
  const nomes = dados.alunos.map(function(a){ return a.id + '|' + a.nome; }).join('\n');
  const mesAtual = new Date().toISOString().slice(0,7);
  const hojeStr = new Date().toISOString().slice(0,10);
  const prompt =
    'Extraia os parâmetros da ação "' + intencao + '" da mensagem abaixo.\n\n' +
    'ALUNOS (id|nome):\n' + nomes + '\n\n' +
    'MENSAGEM: "' + texto + '"\n\n' +
    'Retorne JSON com os campos relevantes (use null para campos não mencionados):\n' +
    '{\n' +
    '  "aluno_id": número ou null,\n' +
    '  "aluno_nome": string ou null,\n' +
    '  "valor": número ou null,\n' +
    '  "mes": "YYYY-MM" ou null (mês atual: ' + mesAtual + '),\n' +
    '  "categoria": string ou null,\n' +
    '  "descricao": string ou null,\n' +
    '  "professora": string ou null,\n' +
    '  "horas": número ou null,\n' +
    '  "meses_utilizados": número ou null,\n' +
    '  "data": "YYYY-MM-DD" ou null (hoje: ' + hojeStr + '),\n' +
    '  "hora": "HH:MM" ou null,\n' +
    '  "status_checkin": "presente" | "falta" | "repos" ou null,\n' +
    '  "custo_id": número ou null\n' +
    '}';

  return await aiJSON(prompt);
}

// ── Executar ação ───────────────────────────────────────────────────────────────
async function executar(intencao, p, dados, chatId) {
  const mes = p?.mes || new Date().toISOString().slice(0,7);

  if (intencao === 'lancar_custo') {
    if (!p?.valor || !p?.categoria) return '❌ Informe o valor e a categoria.';
    const desc = (p.descricao||p.categoria) + ' [via Bot Telegram]';
    await sbPost('custos', { descricao: desc, valor: p.valor, categoria: p.categoria, mes });
    await logOp('custo_lancado', (p.descricao||p.categoria) + ' - ' + mes, null, p.valor, mes, { categoria: p.categoria });
    const cat = p.descricao||p.categoria;
    return '✅ Custo lançado!\n*' + cat + '* - ' + brl(p.valor) + ' - ' + mes + '\n_Para desfazer: "apagar custo ' + p.categoria + ' ' + mes + '"_';
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
      horas: p.horas, vh: vhReal, desc_aula: 'Lançado via Bot Telegram - '+p.horas+'h' });
    await logOp('aula_lancada', profId + ' - ' + p.horas + 'h - ' + data, null, p.horas*vhReal, mes, {profId, horas: p.horas});
    return '✅ Aula lançada!\n*' + profId + '* - ' + p.horas + 'h × ' + brl(vhReal) + ' = ' + brl(p.horas*vhReal) + ' - ' + data + '\n_Para desfazer: "remover aula ' + profId + '"_';
  }

  if (intencao === 'confirmar_pagamento') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno || Array.isArray(aluno)) return Array.isArray(aluno)
      ? '⚠️ Há ' + aluno.length + ' alunos com esse nome. Especifique:\n' + aluno.map((a,i)=>(i+1)+'. '+a.nome+' (id '+a.id+')').join('\n')
      : '❌ Aluno não encontrado: "' + p?.aluno_nome + '".';
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
      desc: 'Pagamento ' + mes + ' via Bot Telegram: ' + brl(p.valor) });
    const patchData = { pagamentos: pags, historico_alteracoes: hist };
    if (tinhaPend) patchData.pagamentos_pendentes = pend;
    await sbPatch('alunos', 'id=eq.' + aluno.id, patchData);
    await logOp('pagamento_confirmado', aluno.nome + ' - ' + mes, aluno.id, p.valor, mes);
    // Cancelar boleto Inter apenas se aluno usa boleto
    const usaBoleto = aluno.forma_pagamento === 'boleto';
    let msgCancelamento = '';
    if (usaBoleto) {
      const nCancelados = await cancelarBoletoPorMes(aluno.id, mes);
      if (nCancelados > 0) msgCancelamento = '\n_Boleto Inter cancelado automaticamente._';
    }
    // Mensagem de pendente só se era realmente boleto/pendência financeira
    const msgPend = tinhaPend && usaBoleto ? '\n_(boleto que estava aguardando foi baixado)_' : '';
    const formaLabel = aluno.forma_pagamento ? ' (' + aluno.forma_pagamento + ')' : '';
    return '✅ Pagamento confirmado!\n*' + aluno.nome + '* - ' + brl(p.valor) + ' - ' + mes + formaLabel + msgPend + msgCancelamento + '\n_Para desfazer: "desfazer pagamento ' + aluno.nome.split(' ')[0] + ' ' + mes + '"_';
  }

  if (intencao === 'desfazer_pagamento') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno || Array.isArray(aluno)) return Array.isArray(aluno)
      ? '⚠️ Há ' + aluno.length + ' alunos com esse nome. Especifique:\n' + aluno.map((a,i)=>(i+1)+'. '+a.nome+' (id '+a.id+')').join('\n')
      : '❌ Aluno não encontrado: "' + p?.aluno_nome + '".';
    const pags = Object.assign({}, typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos):aluno.pagamentos||{});
    const mesD = p?.mes || mes;
    if (!pags[mesD]) return '⚠️ ' + aluno.nome + ' não tem pagamento em ' + mesD + '.';
    const val = pags[mesD];
    delete pags[mesD];
    await sbPatch('alunos', 'id=eq.' + aluno.id, { pagamentos: pags });
    await logOp('pagamento_desfeito', aluno.nome + ' - ' + mesD, aluno.id, val, mesD);
    return '✅ Pagamento desfeito!\n*' + aluno.nome + '* - ' + brl(val) + ' - ' + mesD + ' removido.';
  }

  if (intencao === 'remover_custo' || intencao === 'remover_custo_id') {
    let custo;
    if (intencao === 'remover_custo_id' && p?.custo_id) {
      custo = dados.custos.find(c => (c.id||c._id) === p.custo_id);
      if (!custo) return '❌ Custo ID ' + p.custo_id + ' não encontrado.';
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
        const lista = doMes.map(c => '- ' + (c.descricao||c.categoria) + ' - ' + brl(c.valor)).join('\n');
        return '❌ Custo "' + busca + '" não encontrado em ' + mesR + '.' + (lista ? '\n\nCustos em '+mesR+':\n'+lista : '');
      }
      if (filtro.length > 1) {
        return '⚠️ Encontrei ' + filtro.length + ' registros:\n' +
          filtro.map(c => '- ID ' + (c.id||c._id) + ': ' + (c.descricao||c.categoria) + ' - ' + brl(c.valor)).join('\n') +
          '\n\nMande: "remover custo ID XX"';
      }
      custo = filtro[0];
    }
    await sbDelete('custos', 'id=eq.' + (custo.id||custo._id));
    await logOp('custo_removido', (custo.descricao||custo.categoria) + ' - ' + (custo.mes||''), null, custo.valor, custo.mes);
    return '✅ Custo removido!\n*' + (custo.descricao||custo.categoria).replace(' [via Bot Telegram]','') + '* - ' + brl(custo.valor);
  }

  if (intencao === 'desfazer_aula') {
    const profId = (p?.professora||'').toLowerCase().includes('kelly') ? 'kelly' :
                   (p?.professora||'').toLowerCase().includes('monica') ? 'monica' : null;
    let filtro = dados.aulas;
    if (profId) filtro = filtro.filter(k => k.prof_id === profId);
    if (p?.mes)  filtro = filtro.filter(k => k.mes === p.mes);
    if (!filtro.length) return '❌ Nenhuma aula encontrada' + (profId ? ' para ' + profId : '') + '.';
    const aula = filtro[0];
    await sbDelete('aulas', 'id=eq.' + aula.id);
    await logOp('aula_removida', aula.prof_id + ' - ' + (aula.horas||aula.vh) + 'h - ' + (aula.data_fmt||aula.data), null, null, aula.mes);
    return '✅ Aula removida!\n*' + aula.prof_id + '* - ' + (aula.horas||aula.vh) + 'h - ' + (aula.data_fmt||aula.data);
  }

  if (intencao === 'checkin') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno || Array.isArray(aluno)) return Array.isArray(aluno)
      ? '⚠️ Há ' + aluno.length + ' alunos com esse nome. Especifique:\n' + aluno.map((a,i)=>(i+1)+'. '+a.nome+' (id '+a.id+')').join('\n')
      : '❌ Aluno não encontrado: "' + p?.aluno_nome + '".';
    const status  = p?.status_checkin || 'presente';
    const dataCi  = p?.data || new Date().toISOString().slice(0,10);
    const DIAS_PT = ['Dom','Seg','Ter','Qua','Qui','Sex','Sab'];
    const dow = new Date(dataCi+'T12:00:00').getDay();
    const diaKey = DIAS_PT[dow];
    // Verificar se o dia é feriado (marcado na agenda via modal de feriado)
    const agendaFeriados = dados.changes?.feriados || {};
    if (agendaFeriados[dataCi]) {
      return '🎌 Check-in bloqueado: *' + dataCi.split('-').reverse().join('/') + '* é feriado (' + agendaFeriados[dataCi]||'feriado' + ').\nNão é possível registrar presença em dias de feriado.';
    }
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
      return '⚠️ Horário *' + horaCi + '* não consta na agenda de *' + aluno.nome.split(' ')[0] + '* para ' + diaKey + '.\nHorários cadastrados: ' + horariosValidos.join(', ') + '\nUse um dos horários acima ou corrija a agenda.';
    }
    // Se não informada, busca o primeiro slot
    if (!horaCi && horariosValidos.length > 0) horaCi = horariosValidos[0];
    if (!horaCi) {
      return '⚠️ Não consegui identificar o horário da aula de *' + aluno.nome + '*.\nInforme o horário: _"check-in ' + aluno.nome.split(' ')[0] + ' hoje 10:00"_';
    }
    const ckKey   = dataCi + '-' + horaCi;
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
    await logOp('checkin', aluno.nome + ' - ' + (LABEL[status]||status) + ' - ' + horaCi + ' ' + DIAS[dow2] + ' ' + dataCi, aluno.id, null, dataCi.slice(0,7), {status, hora: horaCi, data: dataCi});
    return LABEL[status] + ' registrado!\n*' + aluno.nome + '* - ' + DIAS[dow2] + ' ' + dataCi.slice(8) + '/' + dataCi.slice(5,7) + ' ' + horaCi + '\n_Recarregue o site para ver o check-in atualizado._';
  }

  if (intencao === 'desfazer_checkin') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno || Array.isArray(aluno)) return Array.isArray(aluno)
      ? '⚠️ Há ' + aluno.length + ' alunos com esse nome. Especifique:\n' + aluno.map((a,i)=>(i+1)+'. '+a.nome+' (id '+a.id+')').join('\n')
      : '❌ Aluno não encontrado: "' + p?.aluno_nome + '".';
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
    if (!removidos) return '⚠️ Nenhum check-in encontrado para *' + aluno.nome + '* em ' + dataCi + '.';
    if (dados.changes) { dados.changes.checkins = ch; await saveChanges(dados.changes); }
    return '✅ Check-in desfeito!\n*' + aluno.nome + '* - ' + dataCi.slice(8) + '/' + dataCi.slice(5,7);
  }

  if (intencao === 'inter_saldo') {
    try {
      const s = await interSaldo();
      if (s && s.disponivel !== undefined) {
        // Horário em BRT (UTC-3)
        const agora = new Date(Date.now() - 3*60*60*1000);
        const horaStr = agora.toISOString().replace('T',' ').slice(0,16) + ' (BRT)';
        return '🏦 *Saldo Banco Inter*\n\n' +
          '💰 Disponível: *' + brl(s.disponivel) + '*\n' +
          (s.bloqueadoCheque   ? '🔒 Bloqueado Cheque: ' + brl(s.bloqueadoCheque) + '\n' : '') +
          (s.bloqueadoJudicial ? '⚖️ Bloqueado Judicial: ' + brl(s.bloqueadoJudicial) + '\n' : '') +
          '\n_Consultado em ' + horaStr + '_';
      }
      return '⚠️ Resposta inesperada do Inter: ' + JSON.stringify(s) + '\n\n_Se o erro for "requested scope is not registered", acesse o Portal Inter → sua aplicação → habilite o escopo "Banking" (extrato e saldo)._';
    } catch(e) { return '❌ Erro Inter: ' + e.message; }
  }

  if (intencao === 'inter_extrato_debug') {
    try {
      const hoje = new Date(Date.now() - 3*60*60*1000);
      const dataFim = hoje.toISOString().slice(0,10);
      const dataInicio = new Date(hoje.getTime() - 30*24*60*60*1000).toISOString().slice(0,10);
      const ext = await Promise.race([
        interExtrato(dataInicio, dataFim),
        new Promise((_,r) => setTimeout(() => r(new Error('Timeout 25s')), 25000))
      ]);
      const transacoes = ext?.transacoes || ext?.content || ext?.items || (Array.isArray(ext) ? ext : []);
      // Pegar a primeira transação de boleto e a primeira de Pix recebido, mostrar JSON cru
      const umBoleto = transacoes.find(t => (t.tipoTransacao||'').includes('BOLETO') || (t.titulo||t.descricao||'').toLowerCase().includes('boleto'));
      const umPix = transacoes.find(t => (t.tipoTransacao||'')==='PIX' && t.tipoOperacao==='C');
      let out = '🔍 *Debug extrato* (campos crus da API)\n\n';
      out += '*Boleto recebido:*\n`' + JSON.stringify(umBoleto || {}, null, 1).slice(0,1500) + '`\n\n';
      out += '*Pix recebido:*\n`' + JSON.stringify(umPix || {}, null, 1).slice(0,800) + '`';
      return out.slice(0, 3900);
    } catch(e) { return '❌ Erro debug extrato: ' + e.message; }
  }

  if (intencao === 'inter_extrato') {
    try {
      const hoje = new Date(Date.now() - 3*60*60*1000); // BRT
      const dataFim = hoje.toISOString().slice(0,10);
      const dataInicio = p?.data_inicio || new Date(hoje.getTime() - 30*24*60*60*1000).toISOString().slice(0,10);
      console.log('[inter_extrato] buscando', dataInicio, 'a', dataFim);
      const ext = await Promise.race([
        interExtrato(dataInicio, dataFim),
        new Promise((_,r) => setTimeout(() => r(new Error('Timeout extrato 25s')), 25000))
      ]);
      console.log('[inter_extrato] ok, keys:', ext ? Object.keys(ext).join(',') : 'null');
      // Se a resposta não veio (null/undefined), foi FALHA de comunicação — não afirmar que
      // não houve transações (seria enganoso). O extrato só está "vazio" se a API respondeu
      // com uma estrutura válida porém sem itens.
      if (ext === null || ext === undefined) {
        return '⚠️ *Extrato Inter* (' + dataInicio + ' a ' + dataFim + ')\n\n' +
               'Não foi possível obter o extrato agora (o serviço pode estar reativando ou o banco demorou a responder). ' +
               'Tente novamente em alguns segundos.';
      }
      const transacoes = ext?.transacoes || ext?.content || ext?.items || (Array.isArray(ext) ? ext : []);
      // Log diagnóstico: Pix sem padrão Cp:
      transacoes.filter(t => t.tipoTransacao==='PIX' && t.tipoOperacao==='C' && !(t.descricao||'').includes('Cp:')).slice(0,3).forEach(t => {
      });
      if (!transacoes.length) return '📄 *Extrato Inter* (' + dataInicio + ' a ' + dataFim + ')\n\n_Nenhuma transação no período (a consulta funcionou, mas não há lançamentos nessas datas)._';

      // Índice de alunos por valor+mês (sem busca extra no Supabase)
      const valorMesParaAlunos = {};
      dados.alunos.forEach(a => {
        const pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
        const pend = typeof a.pagamentos_pendentes==='string'?JSON.parse(a.pagamentos_pendentes||'{}'):(a.pagamentos_pendentes||{});
        [pags, pend].forEach(obj => {
          Object.entries(obj).forEach(([m, v]) => {
            if (v > 0) {
              const key = Math.round(parseFloat(v)) + '-' + m;
              if (!valorMesParaAlunos[key]) valorMesParaAlunos[key] = [];
              const pN = a.nome.split(' ')[0];
              if (!valorMesParaAlunos[key].includes(pN)) valorMesParaAlunos[key].push(pN);
            }
          });
        });
      });

      // Carregar cobranças do Inter para mapear nossoNumero → aluno (via seuNumero).
      // O extrato traz "RECEBIMENTO TITULO - 112/<nossoNumero>"; a cobrança liga ao seuNumero.
      // Estratégia: janelas de EMISSÃO de -18 a +12 meses em passos de 3 meses — É A MESMA
      // que migrarBoletosFuturosParaPendente usa e que comprovadamente captura TODOS os boletos
      // (inclusive os de vencimento futuro como o julho do Vinicius). Janelas pequenas (3 meses)
      // evitam que a paginação trunque resultados em meses com muitos boletos emitidos.
      let nossoNumParaAluno = {};
      try {
        const rIdx = await interCobrancasRobusto({});
        const listaIdx = rIdx?.cobrancas || [];
        listaIdx.forEach(item => {
          const bc = item.cobranca || item;
          const bol = item.boleto || {};
          const nn = String(bol.nossoNumero || bc.nossoNumero || item.nossoNumero || '').replace(/^0+/, '');
          if (!nn) return;
          const psn = parseSeuNumero(bc.seuNumero);
          if (!psn.alunoId) return;
          const al = dados.alunos.find(a => a.id === psn.alunoId);
          if (al) nossoNumParaAluno[nn] = { nome: al.nome.split(' ')[0], venc: (bc.dataVencimento||'').slice(0,7) };
        });
        console.log('[inter_extrato] índice nossoNumero: ' + Object.keys(nossoNumParaAluno).length + ' entradas de ' + listaIdx.length + ' cobranças');
      } catch(eCob) { console.error('[inter_extrato] erro cobranças:', eCob.message); }

      // Carregar boletos do Supabase: reforço por valor/venc E batimento por nossoNumero via API.
      let boletosIndex = [];
      let boletosSupabase = []; // com codigo_solicitacao, para batimento sob demanda
      try {
        const rBol = await sbGet('boletos', 'select=aluno_id,mes,valor,vencimento,status,codigo_solicitacao&order=vencimento.asc');
        const arrBol = Array.isArray(rBol) ? rBol : (rBol?.data || []);
        boletosSupabase = arrBol.filter(b => b.codigo_solicitacao);
        boletosIndex = arrBol.map(b => {
          const al = dados.alunos.find(a => a.id === b.aluno_id);
          return { aluno_id: b.aluno_id, nome: al ? al.nome.split(' ')[0] : null,
                   valor: Math.round(parseFloat(b.valor||0)), vencimento: (b.vencimento||'').slice(0,10) };
        }).filter(b => b.nome);
      } catch(eBol) { console.error('[inter_extrato] erro ao carregar boletos:', eBol.message); }

      // BATIMENTO: para os nossoNumeros que aparecem nas transações de boleto exibidas e NÃO
      // foram resolvidos pela busca de cobranças, consultar a API individual por codigoSolicitacao
      // (da tabela boletos do Supabase) para obter o nossoNumero real e completar o índice.
      // Resolve casos como o julho do Vinicius (boleto que some da busca por janela).
      try {
        const recentes = transacoes.slice().reverse().slice(0,15);
        const nnNaoResolvidos = new Set();
        recentes.forEach(t => {
          if (t.tipoOperacao !== 'C') return;
          if (!((t.tipoTransacao||'')==='BOLETO_COBRANCA' || (t.titulo||t.descricao||'').toLowerCase().includes('boleto'))) return;
          const m = (t.descricao||'').match(/(\d+)\/(\d+)/);
          if (m && m[2]) {
            const nn = m[2].replace(/^0+/, '');
            if (!nossoNumParaAluno[nn]) nnNaoResolvidos.add(nn);
          }
        });
        // Mapear o valor de cada nossoNumero não resolvido (do extrato), para filtrar candidatos
        const valorPorNN = {};
        recentes.forEach(t => {
          if (t.tipoOperacao !== 'C') return;
          const m = (t.descricao||'').match(/(\d+)\/(\d+)/);
          if (m && m[2]) {
            const nn = m[2].replace(/^0+/, '');
            if (nnNaoResolvidos.has(nn)) valorPorNN[nn] = Math.round(parseFloat(t.valor || t.valorOperacao || 0));
          }
        });
        const valoresAlvo = new Set(Object.values(valorPorNN));
        if (nnNaoResolvidos.size && boletosSupabase.length) {
          const token = await interGetToken('boleto-cobranca.read');
          // Candidatos: boletos do Supabase cujo valor bate com algum nossoNumero órfão (mais recentes primeiro)
          const candidatos = boletosSupabase
            .filter(b => valoresAlvo.has(Math.round(parseFloat(b.valor||0))))
            .reverse()
            .slice(0, 30);
          for (const b of candidatos) {
            if (!nnNaoResolvidos.size) break;
            try {
              const det = await Promise.race([
                interReq('/cobranca/v3/cobrancas/' + b.codigo_solicitacao, 'GET', null, token),
                new Promise((_,r) => setTimeout(() => r(new Error('Timeout')), 8000))
              ]);
              const d = det?.data || {};
              const bol = d.boleto || {};
              const bc = d.cobranca || d;
              const nn = String(bol.nossoNumero || bc.nossoNumero || '').replace(/^0+/, '');
              if (nn && nnNaoResolvidos.has(nn)) {
                const al = dados.alunos.find(a => a.id === b.aluno_id);
                if (al) {
                  nossoNumParaAluno[nn] = { nome: al.nome.split(' ')[0], venc: (bc.dataVencimento||b.vencimento||'').slice(0,7) };
                  nnNaoResolvidos.delete(nn);
                }
              }
            } catch(eDet) { /* segue para o próximo */ }
          }
          console.log('[inter_extrato] batimento individual: faltaram', nnNaoResolvidos.size, 'de', candidatos.length, 'consultados');
        }
      } catch(eBat) { console.error('[inter_extrato] erro batimento:', eBat.message); }

      const linhas = transacoes.slice().reverse().slice(0,15).map(t => {
        const sinal = (t.tipoOperacao === 'C') ? '🟢' : '🔴';
        const valNum = parseFloat(t.valor || t.valorOperacao || 0);
        const val = brl(Math.abs(valNum));
        const desc = (t.titulo || t.descricao || t.tipoTransacao || '').slice(0,35);
        const dataStr = (t.dataEntrada || t.dataTransacao || t.dataOperacao || '').slice(0,10);
        const data = dataStr.split('-').reverse().join('/');
        const mes = dataStr.slice(0,7); // YYYY-MM da transação

        let nomeAluno = '';
        if (t.tipoOperacao === 'C') {
          const nomePag = t.nomePagador || t.pagador?.nome || t.remetente?.nome || '';
          if (nomePag && nomePag.trim().length > 2) {
            const pnPag = nomePag.trim().split(' ')[0].toLowerCase();
            const homonimos = dados.alunos.filter(a => a.nome.toLowerCase().split(' ')[0] === pnPag);
            nomeAluno = homonimos.length > 1
              ? ' _(' + nomePag.trim().split(' ').slice(0,2).join(' ') + ')_'
              : ' _(' + nomePag.trim().split(' ')[0] + ')_';
          } else if (t.tipoTransacao === 'PIX' && t.descricao) {
            // Pix: extrair nome do campo "PIX RECEBIDO - Cp :XXXXXXXX-NOME COMPLETO"
            const mPix = t.descricao.match(/Cp\s*:\s*\d+-(.+)/i);
            if (mPix && mPix[1] && mPix[1].trim().length > 2) {
              const preposicoes = ['de','da','do','das','dos','e'];
              const nomeFormatado = mPix[1].trim().split(' ')
                .filter(p => p.length > 0)
                .map(p => preposicoes.includes(p.toLowerCase()) ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
                .join(' ');
              const primeiroNome = nomeFormatado.split(' ')[0].toLowerCase();
              const homonimos = dados.alunos.filter(a => a.nome.toLowerCase().split(' ')[0] === primeiroNome);
              nomeAluno = homonimos.length > 1
                ? ' _(' + nomeFormatado.split(' ').slice(0,2).join(' ') + ')_'
                : ' _(' + nomeFormatado.split(' ')[0] + ')_';
            }
          } else if (t.tipoTransacao === 'BOLETO_COBRANCA') {
            // 1ª tentativa: nossoNumero da descrição → cobrança (identificação EXATA, marca ✓).
            const mNN = (t.descricao || '').match(/(\d+)\/(\d+)/);
            let tinhaNossoNum = false;
            if (mNN && mNN[2]) {
              tinhaNossoNum = true;
              const nn = mNN[2].replace(/^0+/, '');
              const hit = nossoNumParaAluno[nn];
              if (hit) {
                const mesV = hit.venc ? ' ' + hit.venc.split('-').reverse().join('/') : '';
                nomeAluno = ' _(' + hit.nome + mesV + ' ✓)_';
              }
            }
            // 2ª tentativa (só se NÃO extraiu nossoNumero): valor + proximidade do venc → marca ~
            if (!nomeAluno && !tinhaNossoNum) {
              const vAlvo = Math.round(valNum);
              const cands = boletosIndex.filter(b => b.valor === vAlvo);
              const nomesUnicos = [...new Set(cands.map(b => b.nome))];
              if (nomesUnicos.length === 1) {
                nomeAluno = ' _(' + nomesUnicos[0] + ' ~)_';
              } else if (nomesUnicos.length > 1 && dataStr) {
                const tPag = new Date(dataStr).getTime();
                let melhor = null, menorDif = Infinity;
                cands.forEach(b => {
                  if (!b.vencimento) return;
                  const dif = Math.abs(new Date(b.vencimento).getTime() - tPag);
                  if (dif < menorDif) { menorDif = dif; melhor = b; }
                });
                if (melhor && menorDif <= 20*24*60*60*1000) nomeAluno = ' _(' + melhor.nome + ' ~)_';
              }
            }
            // Tinha nossoNumero mas não casou no índice: mostrar o número (marca ?), sem chutar nome
            if (!nomeAluno && tinhaNossoNum && mNN) {
              nomeAluno = ' _(boleto ' + mNN[2] + ' ?)_';
            }
          }
          // Fallback para qualquer tipo sem nome: valor+mês nos pagamentos dos alunos (marca ~)
          if (!nomeAluno) {
            const key = Math.round(valNum) + '-' + mes;
            const candidatos = valorMesParaAlunos[key] || [];
            if (candidatos.length === 1) nomeAluno = ' _(' + candidatos[0] + ' ~)_';
            else if (candidatos.length > 1) nomeAluno = ' _(~' + candidatos.slice(0,2).join('/') + ')_';
          }
        }
        // Detectar cheque devolvido
        const descUp = (t.descricao||t.titulo||'').toUpperCase();
        const chequeDevolvido = t.tipoOperacao === 'D' && 
          (descUp.includes('CHEQUE') || descUp.includes('CHQ') || descUp.includes('DEVOLUCAO') || descUp.includes('DEVOLVIDO'));
        const alertCheque = chequeDevolvido ? ' 🚨 *CHEQUE DEVOLVIDO*' : '';
        return sinal + ' ' + data + ' ' + val + nomeAluno + ' - ' + desc + alertCheque;
      }).join('\n');
      return '📄 *Extrato Inter* (' + dataInicio.split('-').reverse().join('/') + ' a ' + dataFim.split('-').reverse().join('/') + ')\n\n' + linhas +
        (transacoes.length > 15 ? '\n\n_...e mais ' + (transacoes.length - 15) + ' transações._' : '') +
        '\n\n_Legenda: ✓ identificado pelo nº do boleto (exato) · ~ estimado por valor · ? boleto não localizado nas cobranças_';
    } catch(e) { return '❌ Erro extrato Inter: ' + e.message; }
  }

  if (intencao === 'inter_boletos_vencidos') {
    try {
      const hoje = new Date(Date.now() - 3*60*60*1000); // BRT
      const dataFim = hoje.toISOString().slice(0,10);

      console.log('[inter_boletos_vencidos] buscando...');
      // Busca robusta (-18 a +12 meses de emissão) para não perder atrasados de planos longos
      const [rAtr, rAberto] = await Promise.all([
        interCobrancasRobusto({ situacao: 'ATRASADO' }).catch(e => { console.error('rAtr:', e.message); return null; }),
        interCobrancasRobusto({ situacao: 'A_RECEBER' }).catch(e => { console.error('rAberto:', e.message); return null; })
      ]);

      // rAtr.cobrancas: apenas ATRASADO (já filtrado pela API)
      const atrasados = rAtr?.cobrancas || [];
      // emAberto: A_RECEBER que já venceram E ainda não foram pagos/cancelados
      const emAberto = (rAberto?.cobrancas || []).filter(b => {
        const bc = b.cobranca || b;
        const sit = bc.situacao || '';
        const dv = bc.dataVencimento || '';
        return dv < dataFim && sit === 'A_RECEBER'; // só os genuinamente em aberto
      });

      console.log('[inter_boletos_vencidos] atrasados:', atrasados.length, '| emAberto:', emAberto.length);

      // Unificar e deduplicar pelo código (sem EXPIRADO — boletos pagos por Pix ficam nesse status)
      const vistosId = new Set();
      const lista = [...atrasados, ...emAberto].filter(b => {
        const bc = b.cobranca || b;
        const id = bc.codigoSolicitacao || ((bc.seuNumero||'') + '|' + (bc.dataVencimento||''));
        if (vistosId.has(id)) return false;
        vistosId.add(id);
        return true;
      }).filter(b => {
        // Excluir boletos JÁ PAGOS no site (Pix não baixa o boleto no Inter, então um boleto
        // A_RECEBER/ATRASADO pode já ter sido quitado por Pix/dinheiro e confirmado no site).
        const bc = b.cobranca || b;
        const psn = parseSeuNumero(bc.seuNumero);
        const mesB = psn.mes || (bc.dataVencimento || '').slice(0,7);
        if (!psn.alunoId || !mesB) return true; // sem como cruzar — mantém na lista
        const al = dados.alunos.find(a => a.id === psn.alunoId);
        if (!al) return true;
        const pagsB = typeof al.pagamentos==='string'?JSON.parse(al.pagamentos||'{}'):(al.pagamentos||{});
        return !((pagsB[mesB]||0) > 0); // se pago no site, remove dos vencidos
      }).sort((a,b) => (((a.cobranca||a).dataVencimento)||'').localeCompare(((b.cobranca||b).dataVencimento)||''));

      if (!lista.length) return '✅ *Boletos vencidos e não pagos*\n\n_Nenhum boleto atrasado encontrado nos últimos 90 dias._';

      // Estrutura real da API Inter v3: campos dentro de "cobranca", valor como string
      const linhas = lista.map(item => {
        // API retorna { cobranca: {...}, boleto: {...} } — acessar via cobranca
        const b = item.cobranca || item;
        const dataVenc = b.dataVencimento || '';
        const valor    = parseFloat(b.valorNominal || b.valor || 0);
        const nomePag  = b.pagador?.nome || b.nomePagador || '';
        const seuNum   = b.seuNumero || item.boleto?.nossoNumero || '';
        const sit      = b.situacao || 'ATRASADO';

        // Cruzar com aluno: por ID do seuNumero (LCA-id-mes OU número puro antigo), depois por nome
        let nomeAluno = '';
        const psnV = parseSeuNumero(seuNum);
        if (psnV.alunoId) {
          const al = dados.alunos.find(a => a.id === psnV.alunoId);
          if (al) nomeAluno = al.nome.split(' ').slice(0,2).join(' ');
        }
        if (!nomeAluno && nomePag) {
          // Tentar match pelo nome completo do pagador (mais preciso)
          const nomePagLow = nomePag.toLowerCase();
          let al = dados.alunos.find(a => nomePagLow.includes(a.nome.split(' ')[0].toLowerCase()) &&
            nomePagLow.includes((a.nome.split(' ')[1]||'').toLowerCase()) &&
            a.ativo === 'SIM');
          // Fallback: primeiro nome, priorizando ativos
          if (!al) {
            const prim = nomePag.split(' ')[0].toLowerCase();
            if (prim.length > 3) {
              const matches = dados.alunos.filter(a => a.nome.toLowerCase().includes(prim));
              al = matches.find(a => a.ativo === 'SIM') || matches[0];
            }
          }
          nomeAluno = al ? al.nome.split(' ').slice(0,2).join(' ') : nomePag.split(' ').slice(0,2).join(' ');
        }

        const vencFmt   = dataVenc ? dataVenc.slice(0,10).split('-').reverse().join('/') : '?';
        const diasAtraso = dataVenc ? Math.max(0, Math.round((hoje - new Date(dataVenc.slice(0,10) + 'T12:00:00')) / 86400000)) : 0;
        return '🔴 *' + (nomeAluno || nomePag.split(' ').slice(0,2).join(' ') || '?') + '* — ' + brl(valor) + ' — venc. ' + vencFmt + (diasAtraso > 0 ? ' _(' + diasAtraso + 'd atraso)_' : '') + ' [' + sit + ']';
      }).join('\n');

      const total = lista.reduce((s,item) => s + parseFloat((item.cobranca||item).valorNominal || 0), 0);
      return '🔴 *Boletos vencidos e não pagos (' + lista.length + ')*\n\n' + linhas +
        '\n\n💰 *Total em aberto: ' + brl(total) + '*';
    } catch(e) { return '❌ Erro ao buscar boletos Inter: ' + e.message; }
  }

  if (intencao === 'consulta_aluno') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno) return '❌ Aluno não encontrado.';
    const pags = typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos||'{}'):(aluno.pagamentos||{});
    const pend = typeof aluno.pagamentos_pendentes==='string'?JSON.parse(aluno.pagamentos_pendentes||'{}'):(aluno.pagamentos_pendentes||{});
    const todosM = [...new Set([...Object.keys(pags),...Object.keys(pend)])].sort().slice(-12);
    if (!todosM.length) return '📋 *' + aluno.nome.split(' ').slice(0,2).join(' ') + '* — nenhum registro financeiro encontrado.';
    const MESES_PT2 = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const linhas = todosM.reverse().map(m => {
      const v = pags[m]||0;
      const vp = pend[m]||0;
      const label = MESES_PT2[parseInt(m.split('-')[1])-1]+'/'+m.split('-')[0];
      if (v > 0) return '✅ ' + label + ' — ' + brl(v) + ' (pago)';
      if (vp > 0) return '⏳ ' + label + ' — ' + brl(vp) + ' (aguardando)';
      return '🔴 ' + label + ' — pendente';
    }).join('\n');
    return '📋 *Situação financeira — ' + aluno.nome.split(' ').slice(0,2).join(' ') + '*\n' +
      'Plano: ' + aluno.tipo_plano + ' | ' + (aluno.vezes_semana||2) + 'x/sem | ' + aluno.forma_pagamento + '\n\n' + linhas;
  }

  if (intencao === 'inter_boletos_debug') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno) return '❌ Aluno não encontrado.';
    try {
      // Busca robusta (-18 a +12 meses) para capturar todos os boletos, inclusive futuros
      const rRob = await interCobrancasRobusto({});
      const resultados = [rRob];
      const meus = [];
      resultados.forEach(r => {
        (r?.cobrancas || []).forEach(item => {
          const bc = item.cobranca || item;
          const psn = parseSeuNumero(bc.seuNumero);
          if (psn.alunoId === aluno.id) {
            const bol = item.boleto || {};
            meus.push({ seuNumero: bc.seuNumero, codigoSolicitacao: bc.codigoSolicitacao,
                        situacao: bc.situacao, vencimento: bc.dataVencimento, valor: bc.valorNominal,
                        nossoNumero: bol.nossoNumero || bc.nossoNumero || item.nossoNumero,
                        dataHoraSituacao: bc.dataHoraSituacao, dataPagamento: bc.dataPagamento,
                        dataLiquidacao: bc.dataLiquidacao, dataRecebimento: bc.dataRecebimento });
          }
        });
      });
      if (!meus.length) return 'ℹ️ Nenhum boleto encontrado para ' + aluno.nome.split(' ')[0] + ' na janela de 12 meses.';
      let out = '🔍 *Boletos crus — ' + aluno.nome.split(' ')[0] + '* (' + meus.length + ')\n\n';
      meus.forEach((b, i) => {
        out += (i+1) + '. venc ' + (b.vencimento||'?') + ' | ' + (b.situacao||'?') + ' | R$ ' + (b.valor||'?') + '\n';
        out += '   seuNum: `' + (b.seuNumero||'?') + '`\n';
        out += '   nossoNum: `' + (b.nossoNumero||'(VAZIO!)') + '`\n';
        out += '   codSol: `' + (b.codigoSolicitacao||'(VAZIO!)') + '`\n';
      });
      return out.slice(0, 3900);
    } catch(e) { return '❌ Erro debug boletos: ' + e.message; }
  }

  if (intencao === 'inter_boletos') {
    try {
      const situacao = p?.situacao || null;
      // Busca robusta (-18 a +12 meses) captura todos os boletos, inclusive de venc. futuro
      const rRob = await interCobrancasRobusto({ situacao });
      let lista = rRob?.cobrancas || [];
      // Filtrar por aluno se mencionado
      const filtroAluno = encontrarAluno(dados, p);
      if (filtroAluno) {
        // Match por nome exige os 2 primeiros nomes (evita confundir "Ana Luiza" com "Ana Clara")
        const preps = ['de','da','do','das','dos','e'];
        const partesAluno = filtroAluno.nome.toLowerCase().split(/\s+/).filter(x => !preps.includes(x));
        const n1 = partesAluno[0] || '';
        const n2 = partesAluno[1] || '';
        lista = lista.filter(item => {
          const bc = item.cobranca || item;
          const nomePag = (bc.pagador?.nome || '').toLowerCase();
          const partesPag = nomePag.split(/\s+/).filter(x => !preps.includes(x));
          // 1) match seguro por ID (LCA-id-mes OU número puro = id antigo)
          const psn = parseSeuNumero(bc.seuNumero);
          if (psn.alunoId === filtroAluno.id) return true;
          // 2) fallback: primeiro E segundo nome presentes no pagador
          return n1 && n2 && partesPag.includes(n1) && partesPag.includes(n2);
        });
      }
      if (!lista.length) return '📋 *Boletos Inter*' + (filtroAluno ? ' — ' + filtroAluno.nome.split(' ')[0] : '') + '\n\n_Nenhuma cobrança encontrada no período._';
      // Ordenar por data de vencimento
      lista.sort((a,b) => {
        const da = (a.cobranca||a).dataVencimento || '';
        const db = (b.cobranca||b).dataVencimento || '';
        return da.localeCompare(db);
      });
      const linhas = lista.slice(0,20).map(item => {
        const bc = item.cobranca || item;
        // Status: cruzar com o pagamento real no site. Pix não baixa o boleto no Inter,
        // então um boleto A_RECEBER pode já estar pago no site (via Pix/dinheiro).
        const psnB = parseSeuNumero(bc.seuNumero);
        const mesB = psnB.mes || (bc.dataVencimento||'').slice(0,7);
        let pagoNoSite = false;
        if (psnB.alunoId && mesB) {
          const alB = dados.alunos.find(a => a.id === psnB.alunoId);
          if (alB) {
            const pagsB = typeof alB.pagamentos==='string'?JSON.parse(alB.pagamentos||'{}'):(alB.pagamentos||{});
            pagoNoSite = (pagsB[mesB]||0) > 0;
          }
        }
        let status;
        if (bc.situacao === 'PAGO' || bc.situacao === 'RECEBIDO' || bc.situacao === 'MARCADO_RECEBIDO' || pagoNoSite) status = '✅';
        else if (bc.situacao === 'CANCELADO') status = '❌';
        else if (bc.situacao === 'ATRASADO') status = '🔴';
        else status = '⏳';
        const obs = (pagoNoSite && bc.situacao === 'A_RECEBER') ? ' _(pago via Pix/dinheiro)_' : '';
        const val = brl(parseFloat(bc.valorNominal) || 0);
        const nome = filtroAluno ? '' : ' - ' + (bc.pagador?.nome || '').split(' ').slice(0,2).join(' ');
        const venc = (bc.dataVencimento||'').split('-').reverse().join('/');
        const seuN = bc.seuNumero ? ' _[' + bc.seuNumero + ']_' : '';
        return status + ' ' + venc + ' ' + val + nome + seuN + obs;
      }).join('\n');
      const titulo = filtroAluno
        ? '📋 *Boletos Inter — ' + filtroAluno.nome.split(' ').slice(0,2).join(' ') + '*'
        : '📋 *Boletos Inter* (' + (situacao||'todos') + ')';
      return titulo + '\n\n' + linhas +
        (lista.length > 20 ? '\n\n_...e mais ' + (lista.length-20) + '_' : '');
    } catch(e) { return '❌ Erro boletos Inter: ' + e.message; }
  }

  if (intencao === 'inter_emitir_boleto') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno || Array.isArray(aluno)) return Array.isArray(aluno)
      ? '⚠️ Há ' + aluno.length + ' alunos com esse nome. Especifique:\n' + aluno.map((a,i)=>(i+1)+'. '+a.nome+' (id '+a.id+')').join('\n')
      : '❌ Aluno não encontrado: "' + p?.aluno_nome + '".';
    const hoje = new Date();
    const venc = p?.vencimento || new Date(hoje.getFullYear(), hoje.getMonth(), aluno.dia_vencimento||10).toISOString().slice(0,10);
    const cpf = aluno.cpf ? aluno.cpf.replace(/\D/g,'') : '';
    if (!cpf) return '⚠️ *' + aluno.nome + '* não tem CPF cadastrado. Cadastre na ficha antes de emitir o boleto.';
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
      return '⚠️ Não encontrei o valor do plano de *' + aluno.nome.split(' ')[0] + '*.\nQual o valor? (ex: 329)';
    }
    try {
      const result = await interEmitirBoleto({
        valor: valorBoleto, vencimento: venc,
        nomePagador: aluno.nome, cpfCnpj: cpf,
        email: aluno.email || undefined,
        endereco: aluno.logradouro || aluno.endereco || 'Nao informado',
        cidade: aluno.cidade ? aluno.cidade.split('-')[0].trim() : 'Rio de Janeiro',
        uf: aluno.cidade ? (aluno.cidade.split('-')[1]||'RJ').trim() : 'RJ',
        cep: aluno.cep ? aluno.cep.replace(/\D/g,'').slice(0,8) : '20000000',
        numero: aluno.numero || 'S/N',
        complemento: (aluno.complemento && aluno.complemento !== 'null') ? aluno.complemento : undefined,
        descricao: 'Mensalidade Pilates LCA Studio - ' + aluno.nome.split(' ')[0],
        referencia: new Date().toLocaleDateString('pt-BR'),
        seuNumero: gerarSeuNumero(aluno.id, mes)
      });
      if (result?.codigoSolicitacao || result?.nossoNumero) {
        const cod = result.codigoSolicitacao || result.nossoNumero;
        const link = result.linkVisualizacaoBoleto || result.link || '';
        // Gravar boleto na tabela boletos
        await gravarBoleto(aluno.id, mes, cod, gerarSeuNumero(aluno.id, mes), valorBoleto, venc);
        const mesNomeAvulso = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][parseInt(mes.slice(5,7))-1];
        const anoAvulso = mes.slice(0,4);
        const nomeArq = 'Boleto - ' + aluno.nome.split(' ')[0] + ' - ' + mesNomeAvulso + ' ' + anoAvulso + '.pdf';
        const caption = '✅ *Boleto emitido!*\n\n👤 ' + aluno.nome + '\n💰 ' + brl(valorBoleto) + '\n📅 Vencimento: ' + venc.split('-').reverse().join('/') + '\n🔑 Código: ' + cod;
        if (link) {
          try {
            await tgSendPDF(chatId, link, nomeArq, caption);
            return null; // já enviou o arquivo
          } catch(ePdf) {
            console.error('[PDF avulso]', ePdf.message);
          }
        }
        return caption + (link ? '\n\n[Visualizar boleto](' + link + ')' : '') +
          '\n\n_Use "confirmar pagamento ' + aluno.nome.split(' ')[0] + '" quando pagar._';
      }
      return '⚠️ Resposta: ' + JSON.stringify(result).slice(0,200);
    } catch(e) { return '❌ Erro emissão boleto: ' + e.message; }
  }

// ── Mensagens WhatsApp ──────────────────────────────────────────────────────────
function msgWhatsApp(aluno, planoLabel, periodoPlano, valor, diaVenc) {
  const primeiroNome = aluno.nome.split(' ')[0];
  const vezes = aluno.vezes_semana || 2;
  const tel = normalizarTelefone ? normalizarTelefone(aluno.telefone) : '';
  const linhaFone = tel ? '*WhatsApp:* +' + tel + '\n' : '';
  return linhaFone +
    'Olá, ' + primeiroNome + '! 😊\n\n' +
    'Seguem os boletos referentes ao seu plano ' + planoLabel.toLowerCase() + ' no LCA Studio de Pilates.\n\n' +
    '📋 *Plano ' + planoLabel + ' - ' + vezes + 'x por semana*\n' +
    '📅 *Validade: ' + periodoPlano + '*\n' +
    '💰 *' + brl(valor) + '/mês*\n\n' +
    'Os boletos vencem todo dia ' + diaVenc + ' de cada mês. ' +
    'Você também pode pagar via Pix utilizando o QR Code impresso em cada boleto.\n\n' +
    'Qualquer dúvida, estamos à disposição! 🌿\nLCA Studio de Pilates';
}

  if (intencao === 'inter_cobranca_excepcional') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno || Array.isArray(aluno)) return Array.isArray(aluno)
      ? '⚠️ Há ' + aluno.length + ' alunos com esse nome. Especifique:\n' + aluno.map((a,i)=>(i+1)+'. '+a.nome+' (id '+a.id+')').join('\n')
      : '❌ Aluno não encontrado: "' + p?.aluno_nome + '".';
    const cpf = aluno.cpf ? aluno.cpf.replace(/\D/g,'') : '';
    if (!cpf) return '⚠️ *' + aluno.nome + '* não tem CPF cadastrado. Necessário para emitir boleto.';
    const valor = parseFloat(p?.valor) || 0;
    if (!valor || valor <= 0) return '⚠️ Valor inválido para cobrança excepcional.';
    const vencimento = p?.vencimento;
    if (!vencimento) return '⚠️ Vencimento não informado para a cobrança excepcional.';
    const descricao = (p?.descricao || 'Cobranca excepcional').slice(0,120);

    // Endereço (mesma lógica do plano)
    const _limpo = v => (!v || v === 'null' || v === 'undefined') ? '' : String(v).trim();
    const endLogradouro = _limpo(aluno.logradouro) || _limpo(aluno.endereco) || 'Nao informado';
    const endNumero     = _limpo(aluno.numero) || 'S/N';
    const endComplemento = _limpo(aluno.complemento);
    const endBairro     = _limpo(aluno.bairro);
    const endCidadeRaw  = _limpo(aluno.cidade) || 'Rio de Janeiro-RJ';
    const endCidade     = endCidadeRaw.split('-')[0].trim();
    const endUF         = (endCidadeRaw.split('-')[1]||'RJ').trim();
    const endCEP        = aluno.cep ? aluno.cep.replace(/\D/g,'').slice(0,8) : '20000000';
    const fmtData2 = s => { const d=new Date(s+'T00:00:00'); return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear(); };
    const chaveExc = p?.chave || (vencimento.slice(0,7) + '-exc' + Date.now().toString().slice(-6));

    try {
      const res = await interEmitirBoleto({
        valor: valor, vencimento: vencimento,
        nomePagador: aluno.nome, cpfCnpj: cpf,
        email: aluno.email || undefined,
        endereco: endLogradouro, cidade: endCidade, uf: endUF, cep: endCEP,
        numero: endNumero, complemento: endComplemento || undefined, bairro: endBairro || undefined,
        descricao: descricao,
        referencia: 'Cobranca excepcional',
        seuNumero: ('LCA-' + aluno.id + 'E' + Date.now().toString().slice(-5)).slice(0,15)
      });
      if (res?.codigoSolicitacao) {
        await gravarBoleto(aluno.id, chaveExc, res.codigoSolicitacao, 'LCA-' + aluno.id + '-EXC', valor, vencimento);
      }
      const link = res?.linkVisualizacaoBoleto || res?.link || '';
      const cabec = '🧾 *Cobrança excepcional - ' + aluno.nome.split(' ')[0] + '*\n' +
                    '📝 ' + descricao + '\n💰 ' + brl(valor) + ' | vence ' + fmtData2(vencimento);
      if (link) {
        try {
          await tgSendPDF(chatId, link, 'Cobranca - ' + aluno.nome.split(' ')[0] + '.pdf', cabec);
          return null;
        } catch(ePdf) {
          return cabec + '\n[ver boleto](' + link + ')';
        }
      }
      return cabec + (res?.codigoSolicitacao ? '\n✓ Boleto emitido.' : '\n⚠️ Boleto pode não ter sido gerado.');
    } catch(e) {
      console.error('[cobranca_excepcional] erro:', e.message);
      return '❌ Erro ao emitir cobrança excepcional de *' + aluno.nome.split(' ')[0] + '*: ' + e.message.slice(0,120);
    }
  }

  if (intencao === 'inter_emitir_plano') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno || Array.isArray(aluno)) return Array.isArray(aluno)
      ? '⚠️ Há ' + aluno.length + ' alunos com esse nome. Especifique:\n' + aluno.map((a,i)=>(i+1)+'. '+a.nome+' (id '+a.id+')').join('\n')
      : '❌ Aluno não encontrado: "' + p?.aluno_nome + '".';
    const cpf = aluno.cpf ? aluno.cpf.replace(/\D/g,'') : '';
    if (!cpf) return '⚠️ *' + aluno.nome + '* não tem CPF cadastrado. Cadastre na ficha antes de emitir boletos.';
    if (!cpfValido(cpf)) return '⚠️ O CPF de *' + aluno.nome + '* (' + aluno.cpf + ') parece inválido. O banco recusa CPF com dígito verificador errado. Confira o cadastro.';

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
      return '⚠️ Não encontrei o valor do plano de *' + aluno.nome.split(' ')[0] + '*.\nQual o valor mensal? (ex: 329)';
    }
    const valor = valorAuto;

    let anoBase, mesBase;
    if (p?.mes) {
      const pm = p.mes.split('-');
      anoBase = parseInt(pm[0]); mesBase = parseInt(pm[1]) - 1;
    } else if (aluno.data_matricula && /^\d{4}-\d{2}-\d{2}$/.test(aluno.data_matricula)) {
      // Usar o mês da data de matrícula como base (ex: matrícula 10/07 → 1º boleto em julho).
      const pm = aluno.data_matricula.split('-');
      anoBase = parseInt(pm[0]); mesBase = parseInt(pm[1]) - 1;
    } else {
      const hoje = new Date();
      anoBase = hoje.getFullYear(); mesBase = hoje.getMonth();
    }

    const diaVenc = aluno.dia_vencimento || 10;

    // PROTEÇÃO: o Inter recusa boleto com vencimento retroativo ("O valor deve ser igual
    // ou maior à data atual"). Se o 1º vencimento (base + diaVenc) já passou, avança a base
    // mês a mês até o 1º vencimento ser hoje ou futuro. Garante que NENHUM boleto saia no passado.
    {
      const hojeD = new Date(); hojeD.setHours(0,0,0,0);
      let primeiroVenc = new Date(anoBase, mesBase, diaVenc);
      let guard = 0;
      while (primeiroVenc < hojeD && guard < 24) {
        mesBase++;
        if (mesBase > 11) { mesBase = 0; anoBase++; }
        primeiroVenc = new Date(anoBase, mesBase, diaVenc);
        guard++;
      }
      console.log('[PLANO] base calculada:', anoBase + '-' + String(mesBase+1).padStart(2,'0'), '| 1º venc:', primeiroVenc.toISOString().slice(0,10), '| avanços:', guard);
    }

    const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const fmtData = d => String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();

    let dtInicio = new Date(anoBase, mesBase, diaVenc);
    let dtFimReal = new Date(anoBase, mesBase + dur, diaVenc - 1); // último dia do plano: dia anterior ao vencimento após dur meses
    let periodoPlano = fmtData(dtInicio) + ' a ' + fmtData(dtFimReal);
    const planoLabel = plano.charAt(0).toUpperCase() + plano.slice(1);

    // Montar endereço sem null
    const _limpo = v => (!v || v === 'null' || v === 'undefined') ? '' : String(v).trim();
    const endLogradouro = _limpo(aluno.logradouro) || _limpo(aluno.endereco) || 'Nao informado';
    const endNumero     = _limpo(aluno.numero) || 'S/N';
    const endComplemento = _limpo(aluno.complemento);
    const endBairro     = _limpo(aluno.bairro);
    const endCidadeRaw  = _limpo(aluno.cidade) || 'Rio de Janeiro-RJ';
    const endCidade     = endCidadeRaw.split('-')[0].trim();
    const endUF         = (endCidadeRaw.split('-')[1]||'RJ').trim();
    const endCEP        = aluno.cep ? aluno.cep.replace(/\D/g,'').slice(0,8) : '20000000';

    const resultados = [];
    let erros = 0;

    for (let i = 0; i < dur; i++) {
      let dtVenc  = new Date(anoBase, mesBase + i, diaVenc);
      // mês de referência ORIGINAL (para chave/seuNumero únicos, mesmo se a data for remapeada)
      const dtOriginal = new Date(anoBase, mesBase + i, diaVenc);
      const mesStr  = dtOriginal.getFullYear() + '-' + String(dtOriginal.getMonth()+1).padStart(2,'0');
      // Se a data de vencimento já passou, usar hoje + 2 dias (Inter recusa data retroativa)
      const hojeDate = new Date(); hojeDate.setHours(0,0,0,0);
      if (dtVenc < hojeDate) {
        dtVenc = new Date(hojeDate.getTime() + 2*24*60*60*1000);
        console.log('[PLANO] Boleto ' + (i+1) + ': venc original ' + dtOriginal.toISOString().slice(0,10) + ' já passou - usando ' + dtVenc.toISOString().slice(0,10));
      }
      const anoVenc = dtVenc.getFullYear();
      const mesNome = MESES_PT[dtOriginal.getMonth()];
      const numBoleto = i + 1;

      const descricao =
        'Validade do Plano: ' + periodoPlano + ' ' +
        'Boleto ' + numBoleto + ' - ' + mesNome + ' ' + anoVenc;

      try {
        const result = await interEmitirBoleto({
          valor, vencimento: dtVenc.toISOString().slice(0,10),
          nomePagador: aluno.nome, cpfCnpj: cpf,
          email: aluno.email || undefined,
          endereco: endLogradouro,
          cidade: endCidade,
          uf: endUF,
          cep: endCEP,
          numero: endNumero,
          complemento: endComplemento || undefined,
          bairro: endBairro || undefined,
          descricao,
          referencia: 'Boleto ' + numBoleto + ' - ' + mesNome + ' ' + anoVenc,
          seuNumero: gerarSeuNumero(aluno.id, mesStr)
        });
        // Se o Inter rejeitou (sem codigoSolicitacao), tratar como erro com mensagem clara
        if (!result?.codigoSolicitacao) {
          const motivo = result?.detail || result?.title || result?.message ||
            (result?.violacoes && result.violacoes[0] && (result.violacoes[0].razao||result.violacoes[0].propriedade)) ||
            'o banco recusou os dados';
          resultados.push(numBoleto + '. *' + mesNome + ' ' + anoVenc + '* - ❌ ' + String(motivo).slice(0,80));
          erros++;
          if (i < dur - 1) await new Promise(r => setTimeout(r, 800));
          continue;
        }
        const cod  = result?.codigoSolicitacao || result?.nossoNumero || '?';
        let link = result?.linkVisualizacaoBoleto || result?.link || '';
        // O Inter às vezes não retorna o link imediatamente — buscar individualmente
        if (!link && result?.codigoSolicitacao) {
          try {
            await new Promise(r => setTimeout(r, 1500)); // aguardar 1.5s para o Inter gerar
            const token = await interGetToken('boleto-cobranca.read');
            const rBol = await interReq('/cobranca/v3/cobrancas/' + result.codigoSolicitacao, 'GET', null, token);
            link = rBol?.data?.linkVisualizacaoBoleto || rBol?.data?.link || '';
          } catch(eLinkBol) { console.warn('[PDF] erro ao buscar link:', eLinkBol.message); }
        }
        // Gravar boleto na tabela e em pagamentos_pendentes do aluno
        if (result?.codigoSolicitacao) {
          await gravarBoleto(aluno.id, mesStr, result.codigoSolicitacao, gerarSeuNumero(aluno.id, mesStr), valor, dtVenc.toISOString().slice(0,10));
        }
        // Registrar em pagamentos_pendentes para aparecer no histórico financeiro
        try {
          const rAl = await sbGet('alunos', 'select=pagamentos_pendentes,pagamentos&id=eq.' + aluno.id);
          const alAtual = (Array.isArray(rAl) ? rAl[0] : rAl?.data?.[0]) || {};
          const pagAtual = typeof alAtual.pagamentos==='string'?JSON.parse(alAtual.pagamentos||'{}'):(alAtual.pagamentos||{});
          const pendAtual = typeof alAtual.pagamentos_pendentes==='string'?JSON.parse(alAtual.pagamentos_pendentes||'{}'):(alAtual.pagamentos_pendentes||{});
          // Só lançar como pendente se ainda não foi pago
          if (!(pagAtual[mesStr] > 0)) {
            pendAtual[mesStr] = valor;
            await sbPatch('alunos', 'id=eq.' + aluno.id, { pagamentos_pendentes: pendAtual });
          }
        } catch(ePend) { console.error('[emitir_plano] erro ao gravar pendente:', ePend.message); }
        // Enviar PDF com nome correto
        const nomeArq = 'Boleto ' + numBoleto + ' - ' + mesNome + ' ' + anoVenc + ' - ' + aluno.nome.split(' ')[0] + '.pdf';
        if (link) {
          try {
            await tgSendPDF(chatId,link, nomeArq,
              '📄 Boleto ' + numBoleto + '/' + dur + ' - ' + mesNome + ' ' + anoVenc + ' | vence ' + fmtData(dtVenc) + ' | ' + brl(valor));
          } catch(ePdf) {
            console.error('[PDF plano ' + numBoleto + ']', ePdf.message);
            resultados.push(numBoleto + '. *' + mesNome + ' ' + anoVenc + '* - vence ' + fmtData(dtVenc) + ' - [ver](' + link + ')');
          }
        } else {
          resultados.push(numBoleto + '. *' + mesNome + ' ' + anoVenc + '* - vence ' + fmtData(dtVenc) + ' - cod: ' + cod);
        }
      } catch(e) {
        resultados.push(numBoleto + '. *' + mesNome + ' ' + anoVenc + '* - ❌ ' + e.message.slice(0,60));
        erros++;
      }
      if (i < dur - 1) await new Promise(r => setTimeout(r, 800));
    }

    const status = erros === 0 ? '✅' : erros === dur ? '❌' : '⚠️';
    // Registrar a renovação no histórico (igual ao site) para que o cálculo de vencimento
    // use a data real em vez de inferir pelos boletos. Só registra se algo foi emitido.
    if (erros < dur) {
      try {
        const rAlH = await sbGet('alunos', 'select=historico_alteracoes&id=eq.' + aluno.id);
        const alH = (Array.isArray(rAlH) ? rAlH[0] : rAlH?.data?.[0]) || {};
        const histR = alH.historico_alteracoes || [];
        histR.push({
          data: fmtData(dtInicio),
          tipo: 'renovacao',
          valor: valor,
          dia_venc: diaVenc,
          plano_novo: plano,
          plano_anterior: plano,
          desc: 'Renovacao ' + planoLabel + ' (' + dur + ' boletos) via bot - ' + periodoPlano
        });
        await sbPatch('alunos', 'id=eq.' + aluno.id, { historico_alteracoes: histR });
      } catch(eHist) { console.error('[emitir_plano] erro ao registrar renovacao no historico:', eHist.message); }
    }

    const resumo = status + ' *Plano ' + planoLabel + ' - ' + aluno.nome.split(' ')[0] + '*\n' +
      '📋 ' + periodoPlano + '\n💰 ' + brl(valor) + '/mês × ' + dur + ' boletos' +
      (resultados.length ? '\n\n' + resultados.join('\n') : '') +
      (erros === 0 ? '\n\n_Baixa automática via webhook quando pagos._' : '');
    // Enviar mensagem para copiar no WhatsApp
    if (erros === 0) {
      await tgSend(chatId, '✂️ *Copie a mensagem abaixo e envie no WhatsApp da aluna:*');
      await tgSend(chatId, msgWhatsApp(aluno, planoLabel, periodoPlano, valor, diaVenc));
    }
    return resumo;
  }

  if (intencao === 'confirmar_cheque') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno) return '❌ Informe o nome do aluno.\nEx: _"cheque compensou Ana"_';
    const mes = p?.mes || new Date().toISOString().slice(0,7);
    const pend = typeof aluno.pagamentos_pendentes==='string'?JSON.parse(aluno.pagamentos_pendentes||'{}'):(aluno.pagamentos_pendentes||{});
    // Verificar se há cheque pendente
    const hist = aluno.historico_alteracoes || [];
    const eCheque = hist.some(h => h.tipo==='cheque_recebido' && h.desc && h.desc.includes(mes));
    if (!pend[mes] || !eCheque) return 'ℹ️ Nenhum cheque aguardando para *' + aluno.nome.split(' ')[0] + '* em ' + mes + '.';
    const val = pend[mes];
    // Confirmar pagamento
    const pags = typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos||'{}'):(aluno.pagamentos||{});
    pags[mes] = val;
    delete pend[mes];
    const histNovo = [...hist, { data: new Date().toLocaleDateString('pt-BR'), tipo: 'cheque_compensado', desc: 'Cheque compensado - ' + mes + ' - ' + brl(val) }];
    await sbPatch('alunos', 'id=eq.' + aluno.id, { pagamentos: pags, pagamentos_pendentes: pend, historico_alteracoes: histNovo });
    await logOp('cheque_compensado', aluno.nome + ' - ' + mes, aluno.id, val, mes);
    return '✅ *Cheque compensado!*\n\n👤 ' + aluno.nome.split(' ')[0] + '\n💰 ' + brl(val) + '\n📅 ' + mes + '\n\n_Pagamento confirmado no sistema._';
  }

  if (intencao === 'inter_reenviar_boletos') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno || Array.isArray(aluno)) return Array.isArray(aluno)
      ? '⚠️ Há ' + aluno.length + ' alunos com esse nome. Especifique:\n' + aluno.map((a,i)=>(i+1)+'. '+a.nome+' (id '+a.id+')').join('\n')
      : '❌ Informe o nome do aluno.\nEx: _"reenviar boletos Thalita"_';
    // Filtro opcional: valor (ex: "164") ou mês (ex: "junho", "2026-06")
    const filtro = (p?.filtro || '').toLowerCase().trim();
    const MESES_NUM = {janeiro:'01',fevereiro:'02',março:'03',marco:'03',abril:'04',maio:'05',junho:'06',julho:'07',agosto:'08',setembro:'09',outubro:'10',novembro:'11',dezembro:'12'};
    try {
      // Buscar na tabela boletos local
      const r = await sbGet('boletos', 'aluno_id=eq.' + aluno.id + '&select=id,mes,valor,codigo_solicitacao,vencimento,status&order=mes.asc');
      const rArr = Array.isArray(r) ? r : (r?.data || []);
      let boletos = rArr.filter(b => b.status === 'aberto');

      if (!boletos.length) {
        const total = rArr.length || 0;
        if (total > 0) return 'ℹ️ *' + aluno.nome.split(' ')[0] + '* tem ' + total + ' boleto(s) na tabela mas nenhum com status "aberto".\nStatus encontrados: ' + [...new Set(rArr.map(b=>b.status))].join(', ');
        // Sem nenhum registro - buscar na API Inter
        await tgSend(chatId, '🔍 Buscando boletos na API Inter para *' + aluno.nome.split(' ')[0] + '*...');
        const rInter = await interCobrancasRobusto({ situacao: 'A_RECEBER' });
        const cobrancas = rInter?.cobrancas || [];
        // Filtrar pelo seuNumero que começa com LCA-{id}- (campos dentro de .cobranca)
        const prefixo = 'LCA-' + aluno.id + '-';
        boletos = cobrancas
          .filter(c => {
            const sn = (c.cobranca||c).seuNumero || '';
            // boletos do bot (LCA-id-) ou antigos (seuNumero == id puro)
            return sn.startsWith(prefixo) || sn === String(aluno.id);
          })
          .map(c => {
            const bc = c.cobranca || c;
            const bb = c.boleto || {};
            return {
              codigo_solicitacao: bc.codigoSolicitacao,
              mes: (bc.seuNumero||'').startsWith(prefixo) ? (bc.seuNumero||'').replace(prefixo, '') : (bc.dataVencimento||'').slice(0,7),
              valor: bc.valorNominal,
              vencimento: bc.dataVencimento,
              linkVisualizacaoBoleto: bc.linkVisualizacaoBoleto || bb.linkVisualizacaoBoleto || ''
            };
          });
      }

      if (!boletos.length) return 'ℹ️ Nenhum boleto encontrado para *' + aluno.nome.split(' ')[0] + '* na tabela local nem na API Inter.';

      // Aplicar filtro por valor ou mês se informado
      if (filtro) {
        const filtroNum = parseFloat(filtro.replace(',','.'));
        const filtroMes = MESES_NUM[filtro] || (filtro.match(/^\d{4}-\d{2}$/) ? filtro.slice(5,7) : null);
        const boletosFiltrados = boletos.filter(b => {
          if (!isNaN(filtroNum)) return Math.abs((b.valor||0) - filtroNum) < 1; // por valor
          if (filtroMes) return (b.mes||'').slice(5,7) === filtroMes;           // por mês
          return true;
        });
        if (!boletosFiltrados.length) {
          return '⚠️ Nenhum boleto encontrado para *' + aluno.nome.split(' ')[0] + '* com filtro "' + filtro + '".\nBoletos disponíveis: ' +
            boletos.map(b => b.mes + ' R$' + b.valor).join(', ');
        }
        boletos = boletosFiltrados;
      }

      await tgSend(chatId, '📤 Reenviando ' + boletos.length + ' boleto(s) de *' + aluno.nome.split(' ')[0] + '*...');
      const MESES_PT2 = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
      let enviados = 0;
      for (const b of boletos) {
        try {
          let link = b.linkVisualizacaoBoleto || '';
          if (!link && b.codigo_solicitacao) {
            const token = await interGetToken('boleto-cobranca.read');
            // Tentar buscar PDF diretamente
            const pdfResp = await interReq('/cobranca/v3/cobrancas/' + b.codigo_solicitacao + '/pdf', 'GET', null, token);
            // O Inter retorna o PDF em base64 no campo 'pdf' ou diretamente como string
            const pdfBase64 = pdfResp?.data?.pdf || pdfResp?.pdf ||
              (typeof pdfResp?.data === 'string' && pdfResp.data.length > 500 ? pdfResp.data : null) ||
              (typeof pdfResp === 'string' && pdfResp.length > 500 ? pdfResp : null);
            if (pdfBase64) {
              link = 'data:application/pdf;base64,' + pdfBase64;
            } else {
              const det = await interReq('/cobranca/v3/cobrancas/' + b.codigo_solicitacao, 'GET', null, token);
              const cob = det?.cobranca || det?.data?.cobranca || det?.data || det;
              link = cob?.linkVisualizacaoBoleto || cob?.link || cob?.linkBoleto ||
                     det?.linkVisualizacaoBoleto || det?.link || '';
            }
          }
          const mesNome = MESES_PT2[parseInt((b.mes||'').slice(5,7))-1] || b.mes;
          const vencFmt = (b.vencimento||'').split('-').reverse().join('/');
          const nomeArq = 'Boleto - ' + mesNome + ' - ' + aluno.nome.split(' ')[0] + '.pdf';
          const caption = '📄 *' + mesNome + '* | vence ' + vencFmt + ' | ' + brl(b.valor||0);
          if (link) {
            if (link.startsWith('data:application/pdf;base64,')) {
              const pdfBuffer = Buffer.from(link.replace('data:application/pdf;base64,', ''), 'base64');
              await tgSendPDFBuffer(chatId, pdfBuffer, nomeArq, caption);
            } else {
              await tgSendPDF(chatId, link, nomeArq, caption);
            }
            enviados++;
          } else {
            await tgSend(chatId, '⚠️ ' + mesNome + ': link não disponível');
          }
          if (boletos.length > 1) await new Promise(r => setTimeout(r, 600));
        } catch(eBol) {
          await tgSend(chatId, '❌ Erro ' + b.mes + ': ' + eBol.message.slice(0,60));
        }
      }
      // Enviar mensagem para copiar no WhatsApp
      if (enviados > 0) {
        const planoLabelR = (aluno.tipo_plano||'mensal').charAt(0).toUpperCase()+(aluno.tipo_plano||'mensal').slice(1);
        const hoje = new Date();
        const dtIniR = new Date(hoje.getFullYear(), hoje.getMonth(), aluno.dia_vencimento||10);
        const DURACAO = {mensal:1,trimestral:3,semestral:6};
        const durR = DURACAO[aluno.tipo_plano]||1;
        const dtFimR = new Date(dtIniR.getFullYear(), dtIniR.getMonth()+durR-1, (aluno.dia_vencimento||10)-1);
        const fmtR = d => String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear();
        const periodoR = fmtR(dtIniR) + ' a ' + fmtR(dtFimR);
        await tgSend(chatId, '✂️ *Copie a mensagem abaixo e envie no WhatsApp da aluna:*');
        await tgSend(chatId, msgWhatsApp(aluno, planoLabelR, periodoR, boletos[0]?.valor||0, aluno.dia_vencimento||10));
      }
      return enviados > 0 ? null : '⚠️ Não foi possível reenviar. Tente emitir novamente.';
    } catch(e) { return '❌ Erro: ' + e.message; }
  }


  if (intencao === 'alterar_plano') {
    // Parâmetros: aluno_id/aluno_nome, plano_novo, freq_nova, valor, meses_cancelar (array CSV), meses_emitir (array CSV), pro_rata
    const aluno = encontrarAluno(dados, p);
    if (!aluno) return '❌ Aluno não encontrado.';

    const novoPlano  = p?.plano_novo || aluno.tipo_plano;
    const novoFreq   = parseInt(p?.freq_nova) || aluno.vezes_semana || 2;
    const novoValor  = parseFloat(p?.valor) || 0;
    const mesesCancelar = p?.meses_cancelar ? String(p.meses_cancelar).split(',').map(s=>s.trim()).filter(Boolean) : [];
    const mesesEmitir   = p?.meses_emitir   ? String(p.meses_emitir).split(',').map(s=>s.trim()).filter(Boolean)   : [];
    const proRata       = parseFloat(p?.pro_rata) || 0;

    if (!novoValor) return '❌ Informe o novo valor mensal.';
    if (!mesesEmitir.length) return '❌ Informe os meses para os novos boletos.';

    let msgBot = '🔄 *Alteração de Plano — ' + aluno.nome.split(' ')[0] + '*\n\n';
    msgBot += '📋 ' + aluno.tipo_plano + ' ' + (aluno.vezes_semana||2) + 'x → ' + novoPlano + ' ' + novoFreq + 'x/sem\n';
    msgBot += '💰 Novo valor: R$' + brl(novoValor).replace('R$','') + '/mês\n\n';

    // 1. Cancelar boletos Inter em aberto
    let cancelados = 0, errosCancelamento = [];
    for (const mes of mesesCancelar) {
      try {
        const boletos = await sbGet('boletos', 'aluno_id=eq.' + aluno.id + '&mes=eq.' + mes + '&status=eq.aberto&select=id,codigo_solicitacao,valor');
        const lista = Array.isArray(boletos) ? boletos : [];
        for (const b of lista) {
          await interCancelarBoleto(b.codigo_solicitacao);
          await sbPatch('boletos', 'id=eq.' + b.id, { status: 'cancelado', cancelado_em: new Date().toISOString() });
          cancelados++;
        }
      } catch(e) { errosCancelamento.push(mes + ': ' + e.message); }
    }
    if (cancelados > 0) msgBot += '🗑️ ' + cancelados + ' boleto(s) cancelado(s): ' + mesesCancelar.join(', ') + '\n';
    if (errosCancelamento.length) msgBot += '⚠️ Erros cancelamento: ' + errosCancelamento.join(' | ') + '\n';

    // 2. Emitir pró-rata se houver
    if (proRata > 0) {
      const mesProRata = mesesCancelar[0] || new Date().toISOString().slice(0,7);
      try {
        const diaVenc = aluno.dia_vencimento || 10;
        const [ano, mes2] = mesProRata.split('-').map(Number);
        const dtVenc = new Date(ano, mes2-1, diaVenc);
        const seuNum = (gerarSeuNumero(aluno.id, mesProRata) + 'P').slice(0,15);
        const descPR = 'LCA Pilates - Pró-rata ' + (aluno.nome.split(' ')[0]) + ' ' + (mes2+'/'+ano);
        await interEmitirBoleto({
          seuNumero: seuNum, valor: proRata,
          vencimento: dtVenc.toISOString().slice(0,10),
          nomePagador: aluno.nome, cpfCnpj: (aluno.cpf||'00000000000').replace(/\D/g,''),
          email: aluno.email||'', descricao: descPR,
          logradouro: aluno.logradouro||'Nao informado', numero: aluno.numero||'S/N',
          complemento: aluno.complemento||'', bairro: aluno.bairro||'',
          cidade: aluno.cidade||'Rio de Janeiro', cep: (aluno.cep||'20000000').replace(/\D/g,'')
        });
        msgBot += '📊 Pró-rata emitido: R$' + brl(proRata).replace('R$','') + ' — venc. ' + dtVenc.toLocaleDateString('pt-BR') + '\n';
      } catch(e) { msgBot += '⚠️ Erro ao emitir pró-rata: ' + e.message + '\n'; }
    }

    // 3. Emitir novos boletos
    let emitidos = 0, errosEmissao = [];
    const diaVencNovo = aluno.dia_vencimento || 10;
    const DUR_LABEL = { mensal:'Mensal', trimestral:'Trimestral', semestral:'Semestral' };

    for (const mes of mesesEmitir) {
      try {
        const [ano, mesN] = mes.split('-').map(Number);
        const dtVenc = new Date(ano, mesN-1, diaVencNovo);
        const seuNum = gerarSeuNumero(aluno.id, mes);
        const desc = 'LCA Pilates - ' + DUR_LABEL[novoPlano] + ' ' + novoFreq + 'x - ' + aluno.nome.split(' ')[0];
        await interEmitirBoleto({
          seuNumero: seuNum, valor: novoValor,
          vencimento: dtVenc.toISOString().slice(0,10),
          nomePagador: aluno.nome, cpfCnpj: (aluno.cpf||'00000000000').replace(/\D/g,''),
          email: aluno.email||'', descricao: desc,
          logradouro: aluno.logradouro||'Nao informado', numero: aluno.numero||'S/N',
          complemento: aluno.complemento||'', bairro: aluno.bairro||'',
          cidade: aluno.cidade||'Rio de Janeiro', cep: (aluno.cep||'20000000').replace(/\D/g,'')
        });

        // Registrar na tabela boletos
        await sbPost('boletos', {
          aluno_id: aluno.id, mes: mes, valor: novoValor,
          vencimento: dtVenc.toISOString().slice(0,10),
          status: 'aberto', descricao: desc, seu_numero: seuNum
        });
        emitidos++;
      } catch(e) { errosEmissao.push(mes + ': ' + e.message); }
    }

    if (emitidos > 0) msgBot += '\n📄 ' + emitidos + ' novo(s) boleto(s) emitido(s):\n' +
      mesesEmitir.map(function(m){ var p=m.split('-'); return '  • ' + p[1]+'/'+p[0] + ' — R$' + brl(novoValor).replace('R$',''); }).join('\n') + '\n';
    if (errosEmissao.length) msgBot += '⚠️ Erros emissão: ' + errosEmissao.join(' | ') + '\n';

    // 4. Log
    await logOp('alterar_plano', aluno.nome + ' — ' + aluno.tipo_plano + '→' + novoPlano + ' R$' + novoValor + '/mês', aluno.id, novoValor, new Date().toISOString().slice(0,7), { cancelados: mesesCancelar, emitidos: mesesEmitir, proRata });

    msgBot += '\n✅ Alteração concluída!';
    return msgBot;
  }

  if (intencao === 'inter_cancelar_boleto') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno || Array.isArray(aluno)) return Array.isArray(aluno)
      ? '⚠️ Há ' + aluno.length + ' alunos com esse nome. Especifique:\n' + aluno.map((a,i)=>(i+1)+'. '+a.nome+' (id '+a.id+')').join('\n')
      : '❌ Aluno não encontrado: "' + p?.aluno_nome + '".';
    const mes = p?.mes || new Date().toISOString().slice(0,7);
    try {
      const r = await sbGet('boletos', 'aluno_id=eq.' + aluno.id + '&mes=eq.' + mes + '&status=eq.aberto&select=id,codigo_solicitacao,valor,vencimento');
      const boletos = Array.isArray(r) ? r : (r?.data || []);
      if (!boletos.length) return 'ℹ️ Nenhum boleto em aberto para *' + aluno.nome.split(' ')[0] + '* em ' + mes + '.';
      let cancelados = 0;
      for (const b of boletos) {
        await interCancelarBoleto(b.codigo_solicitacao);
        await sbPatch('boletos', 'id=eq.' + b.id, { status: 'cancelado', cancelado_em: new Date().toISOString() });
        cancelados++;
      }
      return '✅ *' + cancelados + ' boleto(s) cancelado(s) no Inter!*\n\n👤 ' + aluno.nome + '\n📅 Mês: ' + mes + '\n\n_Pagamento recebido por outro meio._';
    } catch(e) {
      return '❌ Erro ao cancelar boleto: ' + e.message;
    }
  }

  if (intencao === 'resumo_semanal') {
    await rotinaResumoSemanal();
    return null; // mensagem já enviada pela rotina
  }

  if (intencao === 'backup_agora') {
    await tgSend(chatId, '💾 Gerando backup...');
    await rotinaBackupSemanal();
    return null;
  }

  if (intencao === 'verificar_pix') {
    await tgSend(chatId, '🔍 Verificando Pix recebidos hoje no Inter...');
    return await rotinaDetectarPixAlunos(true); // modo manual: retorna resumo
  }

  if (intencao === 'verificar_boletos_pagos') {
    await tgSend(chatId, '🔍 Verificando boletos pagos no Inter...');
    const r = await verificarBoletosPagosInter();
    if (r.erro) return '❌ Erro ao verificar boletos: ' + r.erro;
    if (!r.confirmados) return 'ℹ️ Nenhum boleto novo para dar baixa (todos os recebidos já estavam confirmados).';
    return '✅ *' + r.confirmados + ' boleto(s) confirmado(s):*\n' + r.nomes.map(n => '• ' + n).join('\n');
  }

  if (intencao === 'corrigir_boletos_preview') {
    await tgSend(chatId, '🔍 Consultando boletos a receber no Inter...');
    return await migrarBoletosFuturosParaPendente(true); // dry-run
  }

  if (intencao === 'corrigir_boletos_aplicar') {
    await tgSend(chatId, '⏳ Aplicando correção...');
    return await migrarBoletosFuturosParaPendente(false);
  }

  if (intencao === 'calcular_rescisao') {
    const aluno = encontrarAluno(dados, p);
    if (!aluno || Array.isArray(aluno)) return Array.isArray(aluno)
      ? '⚠️ Há ' + aluno.length + ' alunos com esse nome. Especifique:\n' + aluno.map((a,i)=>(i+1)+'. '+a.nome+' (id '+a.id+')').join('\n')
      : '❌ Aluno não encontrado: "' + p?.aluno_nome + '".';
    if (aluno.tipo_plano === 'mensal') return '⚠️ ' + aluno.nome + ' tem plano mensal - não há multa de rescisão. Basta inativar.';
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
    return '📋 *Rescisão - ' + aluno.nome + '*\n\n' +
      'Plano: ' + aluno.tipo_plano + ' (' + dur + ' meses)\n' +
      'Valor mensal ref.: ' + brl(valorMensal) + '\n' +
      'Meses utilizados: ' + mUsados + ' | Não usados: ' + mNaoUsados + '\n\n' +
      'Deveria pagar (mensal × usados): ' + brl(deveria) + '\n' +
      'Pago no plano atual: ' + brl(pagosPlanoAtual) + '\n' +
      'Diferença de plano: ' + brl(diferenca) + '\n' +
      'Multa 20% × ' + mNaoUsados + ' meses: ' + brl(multa) + '\n\n' +
      '*Saldo a pagar: ' + brl(saldo) + '*\n\n' +
      '_Confira o valor mensal. Se estiver errado, mande "' + aluno.nome.split(' ')[0] + ' rescindir, ' + mUsados + ' meses, mensal 329"_\n' +
      '_Para confirmar e lançar: responda_ *sim*';
  }

  // Intenção não reconhecida — avisar em vez de silêncio
  return '🤔 Não consegui executar "' + intencao + '". Mande *ajuda* para ver os comandos disponíveis.';
}

const pendente = {};

// ── Processar mensagem ──────────────────────────────────────────────────────────
async function processar(msg) {
  const chatId   = msg.chat.id;
  const username = (msg.from.username||'').toLowerCase();
  const texto    = (msg.text||'').trim();

  // Segurança: só o dono (chat_id imutável) pode comandar o bot.
  // chatId é numérico e não pode ser forjado pelo usuário (diferente de username).
  // TELEGRAM_CHAT_ID sempre existe (env ou fallback), garantindo barreira mesmo sem ALLOWED_USER.
  if (String(chatId) !== String(TELEGRAM_CHAT_ID)) {
    console.log('[seguranca] acesso negado — chatId:', chatId, 'username:', username);
    return tgSend(chatId, '🔒 Acesso não autorizado.');
  }

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
        const ra = await sbGet('alunos', 'id=eq.' + conf.calc.aluno_id + '&select=*');
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

        await sbPatch('alunos', 'id=eq.' + aluno.id, {
          ativo: 'NAO',
          historico_alteracoes: hist,
          pagamentos_pendentes: pend,
          pagamentos_rescisao: pagResc,
          historico: histTxt
        });

        const saldoMsg = conf.calc.saldo > 0.01 ? '\n💰 Saldo a receber lançado: ' + brl(conf.calc.saldo) :
          conf.calc.saldo < -0.01 ? '\n↩️ Saldo a restituir: ' + brl(Math.abs(conf.calc.saldo)) : '\n✅ Quitado';
        return tgSend(chatId, '✅ *Rescisão ' + numeroResc + ' lançada!*\n\n*' + aluno.nome + '* marcado como inativo.' + saldoMsg + '\n\n_Emita o termo formal pelo sistema web (botão Rescindir → 2ª via)._');
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
  // Timeout geral - responde se demorar mais de 45s
  let _timedOut = false;
  const _timer = setTimeout(() => {
    _timedOut = true;
    // Limpar contexto pendente para evitar que a próxima mensagem seja interpretada como valor
    if (ctx[chatId]) delete ctx[chatId];
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
        const resultado = await executar(c.intencao, { aluno_id: c.aluno_id, aluno_nome: c.aluno_nome, valor: valorInformado, mes: c.mes }, dados, chatId);
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
      '👋 *LCA Studio Bot v' + BOT_VERSION + '*\n\n' +
      'Pode me perguntar qualquer coisa sobre o estúdio!\n\n' +
      '*📊 Consultas:*\n' +
      '- _"quem não pagou maio?"_\n' +
      '- _"quem tem plano vencendo?"_\n' +
      '- _"resumo financeiro de maio"_\n' +
      '- _"resumo"_ - resumo semanal com saldo, na hora\n' +
      '- _"backup"_ - exporta JSON completo agora\n' +
      '- _"pix"_ - detecta Pix de alunos recebidos hoje\n' +
      '- _"detectar boletos"_ - dá baixa em boletos pagos no Inter\n' +
      '- _"qual aluna falta mais?"_\n\n' +
      '*💰 Lançamentos:*\n' +
      '- _"custo aluguel 3700 junho"_\n' +
      '- _"kelly deu 2 aulas hoje"_\n' +
      '- _"Ana Lima pagou 329"_\n\n' +
      '*✅ Check-in de aula:*\n' +
      '- _"Luiza presente terça 09:00"_ - marcar presença\n' +
      '- _"Ana faltou hoje 07:00"_ - registrar falta\n' +
      '- _"Maria repôs quinta 10:00"_ - registrar reposição\n\n' +
      '*↩️ Desfazer:*\n' +
      '- _"apagar custo aluguel 2026-05"_\n' +
      '- _"desfazer pagamento Ana maio"_\n' +
      '- _"remover aula kelly"_\n' +
      '- _"saldo da conta"_ - saldo Banco Inter\n' +
      '- _"extrato de hoje"_ / _"extrato do mês"_ - extrato Inter\n' +
      '- _"boletos em aberto"_ / _"boletos pagos este mês"_ - cobranças\n' +
      '- _"emitir boleto Ana R$ 329 vence dia 10"_ - emitir 1 boleto avulso\n' +
      '- _"emitir plano Ana"_ - emitir todos os boletos do plano de uma vez (trimestral=3, semestral=6)\n\n' +
      '*📋 Rescisão:*\n' +
      '- _"Mara quer rescindir, semestral, pagou 3 meses"_'
    );
  }

  // Se Gemini retornou acao com intenção de consulta, redirecionar para consulta_direta
  if (aiResult.tipo === 'acao' && aiResult.intencao && aiResult.intencao.startsWith('consulta_') && aiResult.intencao !== 'consulta_aluno') {
    aiResult.tipo = 'consulta_direta';
  }

  // Consultas diretas - sem IA, resposta imediata
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
        ? '*Inadimplentes em '+mes+' ('+inads.length+'):*\n' + inads.map(a=>'- '+a.nome+' ('+a.tipo_plano+')').join('\n')
        : '✅ Todos os alunos pagaram em '+mes+'.';
    } else if (aiResult.intencao === 'consulta_financeiro') {
      const rec = dados.alunos.reduce(function(s,a){var p=typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});var pr=typeof a.pagamentos_rescisao==='string'?JSON.parse(a.pagamentos_rescisao||'{}'):(a.pagamentos_rescisao||{});return s+(p[mes]||0)-(pr[mes]||0);},0);
      var arec = 0, narec = 0;
      dados.alunos.forEach(function(a){var pd=typeof a.pagamentos_pendentes==='string'?JSON.parse(a.pagamentos_pendentes||'{}'):(a.pagamentos_pendentes||{});if(pd[mes]>0){arec+=pd[mes];narec++;}});
      const cst = dados.custos.filter(function(c){return c.mes===mes;}).reduce(function(s,c){return s+(c.valor||0);},0);
      resp3 = '*Resumo '+mes+':*\n💰 Receita: '+brl(rec)+'\n⏳ A receber: '+brl(arec)+' ('+narec+' boletos)\n📈 Receita esperada: '+brl(rec+arec)+'\n🔴 Custos: '+brl(cst)+'\n💵 Bruto atual: '+brl(rec-cst);
    } else if (aiResult.intencao === 'consulta_vencendo') {
      const pv = dados._planosVencendo || [];
      resp3 = pv.length
        ? '*Planos vencendo (próx. 30 dias):*\n' + pv.map(p=>'- '+p.nome+' - '+p.plano+', dia '+p.diaVenc+'/'+p.mesVenc+' ('+p.dias+' dias)').join('\n')
        : 'Nenhum plano vencendo nos próximos 30 dias.';
    }
    _respondeu=true; return tgSend(chatId, resp3 || '❌ Sem dados.');
  }

  // Se Gemini retornou tipo consulta mas com intenção Inter, forçar execução real
  if (aiResult.tipo === 'consulta' && aiResult.intencao && aiResult.intencao.startsWith('inter_')) {
    aiResult.tipo = 'acao';
  }
  // Consulta livre - IA respondeu direto ou fallback estruturado
  if (aiResult.tipo === 'consulta') {
    clearTimeout(_timer);
    if (aiResult.resposta) return tgSend(chatId, aiResult.resposta);
    // Fallback estruturado - sem IA
    try {
      const tL2 = texto.toLowerCase();
      let fallback = '';
      if (tL2.includes('venc') || tL2.includes('plano')) {
        const pv = (dados._planosVencendo || []);
        fallback = pv.length
          ? '*Planos vencendo (próx. 30 dias):*\n' + pv.map(p=>'- '+p.nome+' - '+p.plano+', vence '+p.dataVenc+' ('+p.dias+' dias)').join('\n')
          : 'Nenhum plano vencendo nos próximos 30 dias.';
      } else if (tL2.includes('inadim') || tL2.includes('pagou')) {
        const mesAtual = mes;
        const inads = dados.alunos.filter(function(a) {
          if (a.ativo !== 'SIM') return false;
          var pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
          return !pags[mesAtual];
        });
        fallback = inads.length
          ? '*Inadimplentes em '+mesAtual+':*\n' + inads.map(a=>'- '+a.nome+' ('+a.tipo_plano+')').join('\n')
          : '✅ Todos pagaram em '+mesAtual+'.';
      } else if (tL2.includes('result') || tL2.includes('resumo') || tL2.includes('financ')) {
        const mesRes = _mesMatch || mes; // usa mês extraído do texto
        const rec = dados.alunos.reduce(function(s,a){var p=typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});var pr=typeof a.pagamentos_rescisao==='string'?JSON.parse(a.pagamentos_rescisao||'{}'):(a.pagamentos_rescisao||{});return s+(p[mesRes]||0)-(pr[mesRes]||0);},0);
        const cst = dados.custos.filter(function(c){return c.mes===mesRes;}).reduce(function(s,c){return s+(c.valor||0);},0);
        const resultado = rec - cst;
        const resIcon = resultado >= 0 ? '[alta] *Resultado: +' : '[baixa] *Resultado: ';
        fallback = '*Resumo ' + mesRes + ':*\n💰 Receita: ' + brl(rec) + '\n🔴 Custos: ' + brl(cst) + '\n' + resIcon + brl(Math.abs(resultado)) + '*' + (resultado < 0 ? ' ⚠️ NEGATIVO' : '');
      } else {
        fallback = '⚠️ Gemini indisponível. Tente em 1 minuto.\nOu use comandos diretos - mande *ajuda*.';
      }
      _respondeu=true; return tgSend(chatId, fallback);
    } catch(err) {
      console.error('Fallback erro:', err.message);
      _respondeu=true; return tgSend(chatId, '⚠️ Gemini indisponível agora. Tente novamente em 1 minuto.');
    }
  }

  // Ação - params já vêm da IA
  const intencao = aiResult.intencao || 'desconhecido';
  if (!intencao || intencao === 'desconhecido') {
    clearTimeout(_timer);
    _respondeu=true; return tgSend(chatId, '🤔 Não entendi. Mande *ajuda* para ver exemplos.');
  }
  const params = aiResult.params || {};

  // Validação anti-alucinação: o valor extraído pela IA deve existir no texto original.
  // (Gemini às vezes troca o valor digitado pelo valor histórico do aluno)
  const intencoesComValor = ['confirmar_pagamento', 'lancar_custo', 'inter_emitir_boleto', 'confirmar_cheque'];
  if (intencoesComValor.includes(intencao) && params.valor) {
    // Números do texto: aceita 359, 1.234,56, 329,00 — exclui anos (20xx) e formatos de mês (2026-06)
    const textoLimpo = texto.replace(/\d{4}-\d{2}/g, ' ');
    // Captura formato brasileiro completo: 1.250,50 | 359 | 329,00
    const nums = (textoLimpo.match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g) || [])
      .map(s => parseFloat(s.replace(/\./g, '').replace(',', '.')))
      .filter(n => !isNaN(n) && !(n >= 2020 && n <= 2035));
    if (nums.length && !nums.includes(parseFloat(params.valor))) {
      // IA inventou um valor que não está no texto — usar o maior número do texto (valor monetário)
      const corrigido = Math.max(...nums);
      console.log('[anti-alucinacao] valor IA', params.valor, '→ texto', corrigido, '|', texto.slice(0,50));
      params.valor = corrigido;
    }
  }

  // Tentar encontrar aluno_id pelo nome se não veio
  if (params.aluno_nome && !params.aluno_id) {
    const al = dados.alunos.find(function(a){ return a.nome.toLowerCase().includes((params.aluno_nome||'').toLowerCase()); });
    if (al) params.aluno_id = al.id;
  }

  // Blindagem: valor numérico explícito no texto prevalece sobre extração da IA
  // (Gemini às vezes ignora o valor digitado e usa o valor de referência do contexto)
  if (intencao === 'confirmar_pagamento' || intencao === 'confirmar_cheque') {
    const numsTexto = (texto.replace(/\d{4}-\d{2}/g, ' ').match(/\d+(?:[.,]\d{1,2})?/g) || [])
      .map(n => parseFloat(n.replace(',', '.')))
      .filter(n => n >= 20 && n <= 10000 && Math.floor(n) !== 2026 && Math.floor(n) !== 2027);
    if (numsTexto.length) {
      const vTexto = numsTexto[numsTexto.length - 1];
      if (!params.valor || Math.abs(params.valor - vTexto) > 0.009) {
        console.log('[valor-texto] sobrescrevendo valor da IA', params.valor, '→', vTexto);
        params.valor = vTexto;
      }
    }
  }

  // Rescisão: mostrar cálculo e aguardar confirmação
  if (intencao === 'calcular_rescisao') {
    const preview = await executar(intencao, params, dados, chatId);
    clearTimeout(_timer);
    if (preview) {
      // Recalcular os dados estruturados para o lançamento (mesma fórmula do preview)
      const aluno = encontrarAluno(dados, params);
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

  let resultado;
  try {
    resultado = await executar(intencao, params, dados, chatId);
  } catch(e) {
    console.error('[executar] erro na intenção', intencao, ':', e.message);
    clearTimeout(_timer);
    if (_timedOut) return;
    _respondeu=true;
    return tgSend(chatId, '❌ Ocorreu um erro ao executar a ação. Tente novamente.\n_Detalhe: ' + (e.message||'desconhecido').slice(0,80) + '_');
  }
  clearTimeout(_timer);
  if (_timedOut) return;
  _respondeu=true;
  if (resultado === null) return; // PDF já enviado diretamente
  return tgSend(chatId, resultado || '❌ Não consegui executar a ação.');
}

// ── Rotina diária de aniversariantes ────────────────────────────────────────────
async function enviarAniversariantesHoje() {
  try {
    const dados = await getDados();
    const hoje = new Date(Date.now() - 3*60*60*1000);
    const dh = String(hoje.getDate()).padStart(2,'0');
    const mh = String(hoje.getMonth()+1).padStart(2,'0');

    const aniv = dados.alunos.filter(a => {
      const aniversario = a.aniversario || '';
      return aniversario.indexOf(dh + '/' + mh) === 0;
    });

    if (!aniv.length) return; // nenhum aniversariante hoje

    const linhas = aniv.map(a => {
      const nome1 = a.nome.split(' ')[0];
      const fem = (a.sexo || 'F') === 'F';
      const ativo = a.ativo === 'SIM';
      const ola = fem ? 'a' : 'o';
      const bem = fem ? 'bem-vinda' : 'bem-vindo';
      const tel = a.telefone ? a.telefone.replace(/[^0-9]/g,'') : '';
      const telInfo = tel ? '📱 55' + tel : '📵 sem telefone';
      const status = ativo ? '🟢 Ativa(o)' : '🔴 Inativa(o)';

      let msg;
      if (ativo) {
        msg = '🎂 Feliz aniversário, ' + nome1 + '!\n\n' +
          'Que este novo ano de vida seja repleto de saúde, alegria e muita energia! ' +
          'É uma alegria enorme tê-l' + ola + ' aqui no LCA, cuidando do seu corpo e da sua qualidade de vida com tanto carinho e dedicação.\n\n' +
          'Que os próximos anos sejam cada vez mais leves - no movimento e no coração. 💛\n\n' +
          'Com carinho, Equipe LCA Studio de Pilates';
      } else {
        msg = '🎂 Feliz aniversário, ' + nome1 + '!\n\n' +
          'Que este novo ano de vida seja cheio de saúde e momentos especiais. ' +
          'Você faz parte da história do LCA e a gente não esquece disso.\n\n' +
          'E se um dia quiser voltar, será sempre ' + bem + '. 🌿\n\n' +
          'Com carinho, Equipe LCA Studio de Pilates';
      }

      return '👤 *' + a.nome + '* - ' + status + '\n' + telInfo + '\n\n📋 *Mensagem para copiar:*\n```\n' + msg + '\n```';
    });

    const cabecalho = '🎂 *Aniversariantes de hoje (' + dh + '/' + mh + '):*\n\n';
    // Telegram tem limite de 4096 chars - enviar uma mensagem por aniversariante se necessário
    for (const linha of linhas) {
      await tgSend(TELEGRAM_CHAT_ID, cabecalho + linha);
    }
  } catch(e) {
    console.error('Erro rotina aniversariantes:', e.message);
  }
}

// ── Agendamento da rotina ───────────────────────────────────────────────────────

// ── Fila de emissão automática de boletos ─────────────────────────────────────
async function processarFilaBoletos() {
  try {
    // Buscar pedidos pendentes
    const r = await sbGet('fila_boletos', 'status=eq.pendente&select=*&order=criado_em.asc&limit=5');
    const fila = Array.isArray(r) ? r : (r?.data || []);
    if (!fila.length) return;

    console.log('[fila_boletos] ' + fila.length + ' pedido(s) pendente(s)');
    const dados = await getDados();

    for (const pedido of fila) {
      try {
        const aluno = dados.alunos.find(a => a.id === pedido.aluno_id);
        if (!aluno) {
          await sbPatch('fila_boletos', 'id=eq.' + pedido.id, { status: 'erro', obs: 'aluno não encontrado' });
          continue;
        }
        if (!aluno.cpf) {
          await sbPatch('fila_boletos', 'id=eq.' + pedido.id, { status: 'erro', obs: 'sem CPF' });
          await tgSend(TELEGRAM_CHAT_ID, '⚠️ Não foi possível emitir boletos de *' + aluno.nome + '* automaticamente: CPF não cadastrado.\nCadastre o CPF e emita manualmente: _"emitir plano ' + aluno.nome.split(' ')[0] + '"_');
          continue;
        }

        // Marcar como processando
        await sbPatch('fila_boletos', 'id=eq.' + pedido.id, { status: 'processando' });

        let resultado;
        if (pedido.obs && pedido.obs.startsWith('alteracao_plano|')) {
          // Pedido de alteração de plano: cancelar e emitir conforme parâmetros
          const partes = {};
          pedido.obs.split('|').slice(1).forEach(s => {
            const [k, v] = s.split(':');
            partes[k] = v || '';
          });
          resultado = await executar(
            'alterar_plano',
            { aluno_id: aluno.id, aluno_nome: aluno.nome,
              plano_novo: pedido.tipo_plano, valor: pedido.valor,
              meses_cancelar: partes.cancelar, meses_emitir: partes.emitir,
              pro_rata: partes.prorata },
            dados, TELEGRAM_CHAT_ID
          );
          if (resultado) await tgSend(TELEGRAM_CHAT_ID, resultado);
        } else if (pedido.obs && pedido.obs.startsWith('excepcional|')) {
          // Cobrança excepcional: emite UM boleto avulso com valor/vencimento/descrição próprios.
          const partesE = {};
          pedido.obs.split('|').slice(1).forEach(s => {
            const idx = s.indexOf(':');
            if (idx > 0) partesE[s.slice(0,idx)] = s.slice(idx+1);
          });
          resultado = await executar(
            'inter_cobranca_excepcional',
            { aluno_id: aluno.id, aluno_nome: aluno.nome,
              valor: parseFloat(partesE.valor)||pedido.valor,
              vencimento: partesE.venc, descricao: partesE.desc || 'Cobranca excepcional',
              chave: partesE.chave || '' },
            dados, TELEGRAM_CHAT_ID
          );
          if (resultado) await tgSend(TELEGRAM_CHAT_ID, resultado);
        } else {
          // Pedido normal: emitir plano completo
          resultado = await executar(
            'inter_emitir_plano',
            { aluno_id: aluno.id, aluno_nome: aluno.nome },
            dados,
            TELEGRAM_CHAT_ID,
            new Date().toISOString().slice(0,7)
          );
        }

        await sbPatch('fila_boletos', 'id=eq.' + pedido.id, { status: 'concluido', obs: (pedido.obs||'') + ' [processado]' });
        console.log('[fila_boletos] Boletos emitidos para', aluno.nome);
      } catch(e) {
        console.error('[fila_boletos] erro no pedido', pedido.id, e.message);
        await sbPatch('fila_boletos', 'id=eq.' + pedido.id, { status: 'erro', obs: e.message.slice(0,200) });
        await tgSend(TELEGRAM_CHAT_ID, '❌ Erro ao emitir boletos de *' + (pedido.aluno_nome||'?') + '* automaticamente: ' + e.message.slice(0,100));
      }
    }
  } catch(e) {
    console.error('[fila_boletos] erro geral:', e.message);
  }
}



// ── Rotina: detectar Pix recebidos de alunos no extrato (a cada 30 min) ─────
const _pixProcessados = new Set(); // chave: data|valor|nome (evita duplicar no mesmo processo)
// Rotina (30 min): varre o extrato do dia buscando Pix recebidos, casa nome do pagador com aluno (2 nomes), lança pagamento e notifica.
async function rotinaDetectarPixAlunos(retornarResumo) {
  let lancados = 0, semMatch = 0, jaPagos = 0;
  const lancadosNomes = [];
  try {
    const hojeBR = new Date(Date.now() - 3*60*60*1000);
    const hojeStr = hojeBR.toISOString().slice(0,10);
    const mesAtualStr = hojeStr.slice(0,7);

    const ext = await Promise.race([
      interExtrato(hojeStr, hojeStr),
      new Promise((_,r) => setTimeout(() => r(new Error('Timeout extrato 25s')), 25000))
    ]);
    const transacoes = ext?.transacoes || ext?.content || ext?.items || (Array.isArray(ext) ? ext : []);
    if (!transacoes.length) return retornarResumo ? '🔍 Nenhuma transação no extrato de hoje ainda.' : undefined;

    // Pix de crédito (recebidos)
    const pixRecebidos = transacoes.filter(t =>
      t.tipoTransacao === 'PIX' && t.tipoOperacao === 'C' && parseFloat(t.valor||0) > 0
    );
    if (!pixRecebidos.length) return retornarResumo ? '🔍 Nenhum Pix recebido hoje no extrato.' : undefined;

    const dados = await getDados();
    const preposicoes = ['de','da','do','das','dos','e'];

    for (const t of pixRecebidos) {
      const valor = parseFloat(t.valor||0);
      // Extrair nome do pagador: "PIX RECEBIDO - Cp :XXXXXXXX-NOME COMPLETO"
      const mPix = (t.descricao||'').match(/Cp\s*:\s*\d+-(.+)/i);
      if (!mPix || !mPix[1] || mPix[1].trim().length < 3) continue;
      const nomePagador = mPix[1].trim().toLowerCase();
      const partesPag = nomePagador.split(/\s+/).filter(p => !preposicoes.includes(p));

      const chave = hojeStr + '|' + valor + '|' + nomePagador;
      if (_pixProcessados.has(chave)) continue;

      // Match: primeiro E segundo nome do aluno presentes no nome do pagador
      const candidatos = dados.alunos.filter(a => {
        if (a.ativo !== 'SIM') return false;
        const partesAluno = a.nome.toLowerCase().split(/\s+/).filter(p => !preposicoes.includes(p));
        if (partesAluno.length < 2) return false;
        return partesPag.includes(partesAluno[0]) && partesPag.includes(partesAluno[1]);
      });

      if (candidatos.length !== 1) { semMatch++; continue; } // sem match único e seguro, ignorar
      const aluno = candidatos[0];

      // Já pagou o mês? pular (evita duplicar com rotina de boletos e lançamentos manuais)
      const pags = typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos||'{}'):(aluno.pagamentos||{});
      if ((pags[mesAtualStr]||0) > 0) { _pixProcessados.add(chave); jaPagos++; continue; }

      // Lançar pagamento automaticamente
      _pixProcessados.add(chave);
      try {
        pags[mesAtualStr] = valor;
        const pend = typeof aluno.pagamentos_pendentes==='string'?JSON.parse(aluno.pagamentos_pendentes||'{}'):(aluno.pagamentos_pendentes||{});
        const tinhaPend = (pend[mesAtualStr]||0) > 0;
        if (tinhaPend) delete pend[mesAtualStr];
        const hist = aluno.historico_alteracoes || [];
        hist.push({ data: hojeBR.toLocaleDateString('pt-BR'), tipo: 'pagamento',
          desc: 'Pagamento ' + mesAtualStr + ' via Pix Inter (detectado no extrato): ' + brl(valor) });
        const patch = { pagamentos: pags, historico_alteracoes: hist };
        if (tinhaPend) patch.pagamentos_pendentes = pend;
        await sbPatch('alunos', 'id=eq.' + aluno.id, patch);
        await logOp('pix_detectado', aluno.nome + ' - ' + mesAtualStr, aluno.id, valor, mesAtualStr);
        await tgSend(TELEGRAM_CHAT_ID,
          '💸 *Pix detectado e lançado!*\n\n' +
          '👤 ' + aluno.nome + '\n' +
          '💰 ' + brl(valor) + '\n' +
          '📅 ' + mesAtualStr + ' — Pix recebido hoje no Inter.\n\n' +
          '_Para desfazer: "desfazer pagamento ' + aluno.nome.split(' ')[0] + ' ' + mesAtualStr + '"_');
        console.log('[rotina-pix] lançado:', aluno.nome, valor);
        lancados++;
        lancadosNomes.push(aluno.nome.split(' ').slice(0,2).join(' ') + ' (' + brl(valor) + ')');
      } catch(e) {
        console.error('[rotina-pix] erro ao lançar:', aluno.nome, e.message);
      }
    }
  } catch(e) {
    console.error('[rotina-pix] erro geral:', e.message);
    if (retornarResumo) return '❌ Erro ao verificar Pix: ' + e.message;
  }

  if (retornarResumo) {
    if (lancados > 0) {
      return '✅ *' + lancados + ' Pix lançado(s):*\n' + lancadosNomes.map(n => '• ' + n).join('\n') +
        (jaPagos ? '\n\n_' + jaPagos + ' Pix de aluno(s) que já estavam pagos (ignorados)._' : '');
    }
    return '🔍 Nenhum Pix novo de aluno para lançar.\n' +
      (jaPagos ? '• ' + jaPagos + ' Pix de aluno(s) já pagos\n' : '') +
      (semMatch ? '• ' + semMatch + ' Pix sem correspondência segura (nome não bate com 2 nomes de aluno ativo)\n' : '') +
      '\n_Pix de terceiros ou com nome diferente do cadastro precisam de lançamento manual._';
  }
}

// ── Rotina proativa: detectar boletos pagos no Inter ─────────────────────────
async function verificarBoletosPagosInter() {
  try {
    // IMPORTANTE: o filtro de cobranças do Inter é por data de EMISSÃO, não de pagamento.
    // Um boleto emitido há meses (ex: plano semestral emitido de uma vez) pode ser pago hoje.
    // Por isso usamos a busca robusta (-18 a +12 meses), buscando os pagos nos dois status.
    const [rMarcado, rRecebido] = await Promise.all([
      interCobrancasRobusto({ situacao: 'MARCADO_RECEBIDO' }).catch(() => ({ cobrancas: [] })),
      interCobrancasRobusto({ situacao: 'RECEBIDO' }).catch(() => ({ cobrancas: [] }))
    ]);
    const resultados = [rMarcado, rRecebido];

    // Unificar e deduplicar por codigoSolicitacao (mesmo boleto pode vir em status/blocos diferentes)
    const vistos = new Set();
    const lista = [];
    resultados.forEach(r => {
      (r?.cobrancas || []).forEach(item => {
        const bc = item.cobranca || item;
        // Dedup por codigoSolicitacao (único por boleto). Se faltar, usar seuNumero+vencimento —
        // NUNCA só seuNumero, pois boletos antigos do mesmo aluno compartilham o seuNumero (ex: "98"),
        // e dois boletos (jun e jul) seriam tratados como duplicados, descartando um deles.
        const id = bc.codigoSolicitacao || ((bc.seuNumero||'') + '|' + (bc.dataVencimento||''));
        if (vistos.has(id)) return;
        vistos.add(id);
        lista.push(item);
      });
    });

    if (!lista.length) return { confirmados: 0, nomes: [] };

    const dados = await getDados();
    let confirmados = 0;
    const confirmadosNomes = [];

    // PROTEÇÃO (a API do Inter NÃO retorna data de pagamento, então não dá pra filtrar por recência):
    // só dar baixa quando (1) o aluno está ATIVO e (2) o mês do boleto está em pagamentos_pendentes
    // do aluno — ou seja, é um boleto que o sistema EMITIU e ESTÁ ESPERANDO receber.
    // Isso impede reprocessar boletos antigos de inativos (ex: Edno) ou meses não esperados,
    // já que o status RECEBIDO no Inter é permanente e a busca varre 12 meses de emissão.
    for (const item of lista) {
      const bc = item.cobranca || item;
      const psn = parseSeuNumero(bc.seuNumero);
      if (!psn.alunoId) continue;

      const alunoId = psn.alunoId;
      const mes = psn.mes || (bc.dataVencimento || '').slice(0,7);
      if (!mes) continue;
      const valor = parseFloat(bc.valorNominal || 0);
      if (!valor) continue;

      const aluno = dados.alunos.find(a => a.id === alunoId);
      if (!aluno) continue;
      // (1) Só aluno ativo
      if (aluno.ativo !== 'SIM') continue;
      const pags = typeof aluno.pagamentos==='string'?JSON.parse(aluno.pagamentos||'{}'):(aluno.pagamentos||{});
      if ((pags[mes]||0) > 0) continue; // já confirmado
      // (2) Só se o mês está em pagamentos_pendentes (boleto que o sistema espera receber)
      const pend = typeof aluno.pagamentos_pendentes==='string'?JSON.parse(aluno.pagamentos_pendentes||'{}'):(aluno.pagamentos_pendentes||{});
      if (!(pend[mes] > 0)) continue; // não estava esperando esse mês → não baixa

      // Confirmar pagamento
      try {
        pags[mes] = valor;
        const tinhaPend = (pend[mes]||0) > 0;
        if (tinhaPend) delete pend[mes];
        const hist = aluno.historico_alteracoes || [];
        hist.push({ data: new Date().toLocaleDateString('pt-BR'), tipo: 'pagamento',
          desc: 'Pagamento ' + mes + ' via boleto Inter (rotina automática): ' + brl(valor) });
        const patch = { pagamentos: pags, historico_alteracoes: hist };
        if (tinhaPend) patch.pagamentos_pendentes = pend;
        await sbPatch('alunos', 'id=eq.' + alunoId, patch);
        await logOp('boleto_pago_rotina', aluno.nome + ' - ' + mes, alunoId, valor, mes);
        await tgSend(TELEGRAM_CHAT_ID,
          '🏦 *Pagamento confirmado automaticamente!*\n\n' +
          '👤 ' + aluno.nome + '\n' +
          '💰 ' + brl(valor) + '\n' +
          '📅 ' + mes + ' — boleto Inter baixado.\n' +
          '_Detectado pela rotina automática._');
        confirmados++;
        confirmadosNomes.push(aluno.nome.split(' ')[0] + ' (' + mes + ')');
        console.log('[rotina-inter] Pagamento confirmado:', aluno.nome, mes, valor);
      } catch(e) {
        console.error('[rotina-inter] erro ao confirmar:', aluno.nome, e.message);
      }
    }
    if (confirmados > 0) console.log('[rotina-inter] Total confirmados:', confirmados);
    return { confirmados, nomes: confirmadosNomes };
  } catch(e) {
    console.error('[rotina-inter] erro geral:', e.message);
    return { confirmados: 0, nomes: [], erro: e.message };
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// ── Rotinas automáticas agendadas ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// Controle de execução única por dia (evita duplicar se bot reiniciar)
const _rotinasExecutadas = {}; // chave: 'nomeRotina-YYYY-MM-DD'
// Helper de controle das rotinas: retorna true se a rotina nomeada já rodou hoje (evita duplicação após reinício do Render).
function _jaExecutouHoje(nome) {
  const hojeBR = new Date(Date.now() - 3*60*60*1000).toISOString().slice(0,10);
  const chave = nome + '-' + hojeBR;
  if (_rotinasExecutadas[chave]) return true;
  _rotinasExecutadas[chave] = true;
  // Limpar chaves antigas (manter só 7 dias)
  Object.keys(_rotinasExecutadas).forEach(k => {
    const dt = k.slice(-10);
    if ((Date.now() - new Date(dt).getTime()) > 7*86400000) delete _rotinasExecutadas[k];
  });
  return false;
}

// ── 2. Alerta diário de inadimplência (09:00 BRT) ──────────────────────────
async function rotinaAlertaInadimplencia() {
  try {
    const hoje = new Date(Date.now() - 3*60*60*1000);
    const ontem = new Date(hoje.getTime() - 86400000);
    const diaOntem = ontem.getDate();
    const mesAtualStr = hoje.toISOString().slice(0,7);
    const dados = await getDados();

    // Alunos ativos cujo dia de vencimento foi ontem e não pagaram o mês atual
    const vencidosOntem = dados.alunos.filter(a => {
      if (a.ativo !== 'SIM') return false;
      if (parseInt(a.dia_vencimento||0) !== diaOntem) return false;
      const pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
      return !(pags[mesAtualStr] > 0);
    });

    if (!vencidosOntem.length) return;

    // Buscar os boletos do mês atual desses alunos para obter o vencimento real do boleto
    const idsVenc = vencidosOntem.map(a => a.id);
    let boletosMes = {};
    try {
      const rB = await sbGet('boletos', 'aluno_id=in.(' + idsVenc.join(',') + ')&mes=eq.' + mesAtualStr + '&select=aluno_id,vencimento,status');
      const arrB = Array.isArray(rB) ? rB : (rB?.data || []);
      arrB.forEach(b => { if (!boletosMes[b.aluno_id]) boletosMes[b.aluno_id] = b.vencimento; });
    } catch(eB) { console.error('[rotina-inadimplencia] boletos:', eB.message); }

    const fmtData = (d) => {
      if (!d) return null;
      const dt = (d instanceof Date) ? d : new Date(d);
      if (isNaN(dt.getTime())) return null;
      return String(dt.getDate()).padStart(2,'0') + '/' + String(dt.getMonth()+1).padStart(2,'0') + '/' + dt.getFullYear();
    };

    const linhas = vencidosOntem.map(a => {
      const pend = typeof a.pagamentos_pendentes==='string'?JSON.parse(a.pagamentos_pendentes||'{}'):(a.pagamentos_pendentes||{});
      const temBoleto = (pend[mesAtualStr]||0) > 0;
      // Vencimento do boleto: da tabela boletos (preferido) ou montado de mes+dia_vencimento
      let vencBoleto = boletosMes[a.id];
      if (!vencBoleto && a.dia_vencimento) {
        vencBoleto = mesAtualStr + '-' + String(a.dia_vencimento).padStart(2,'0');
      }
      const vbFmt = fmtData(vencBoleto);
      // Vencimento do plano
      const vpFmt = fmtData(calcVencimentoPlanoBot(a));
      let linha = '🔴 *' + a.nome.split(' ').slice(0,2).join(' ') + '* — ' + a.tipo_plano + ' (' + a.forma_pagamento + ')' +
        (temBoleto ? ' — boleto emitido aguardando' : '');
      if (vbFmt) linha += '\n   📄 Boleto vence: ' + vbFmt;
      if (vpFmt) linha += '\n   📅 Plano vence: ' + vpFmt;
      return linha;
    }).join('\n\n');

    await tgSend(TELEGRAM_CHAT_ID,
      '⚠️ *Vencimentos de ontem sem pagamento (' + vencidosOntem.length + ')*\n\n' + linhas +
      '\n\n_Para confirmar: "Fulana pagou"_');
    console.log('[rotina-inadimplencia] alertados:', vencidosOntem.length);
  } catch(e) { console.error('[rotina-inadimplencia] erro:', e.message); }
}

// ── 5. Alerta de planos vencendo em 7 dias (09:00 BRT) ─────────────────────
async function rotinaPlanosVencendo() {
  try {
    const dados = await getDados();
    const mesAtual = new Date(Date.now() - 3*60*60*1000).toISOString().slice(0,7);
    buildContexto(dados, mesAtual); // popula dados._planosVencendo
    const pv = (dados._planosVencendo || []).filter(p => p.dias === 7 || p.dias === 3 || p.dias === 0);
    if (!pv.length) return;

    const linhas = pv.map(p => {
      const quando = p.dias === 0 ? 'VENCE HOJE' : 'vence em ' + p.dias + ' dias';
      return '📋 *' + p.nome.split(' ').slice(0,2).join(' ') + '* — ' + p.plano + ' ' + quando + ' (' + p.dataVenc + ')';
    }).join('\n');

    await tgSend(TELEGRAM_CHAT_ID,
      '🔔 *Planos vencendo*\n\n' + linhas +
      '\n\n_Entre em contato para renovação._');
    console.log('[rotina-planos-vencendo] alertados:', pv.length);
  } catch(e) { console.error('[rotina-planos-vencendo] erro:', e.message); }
}

// ── 6. Detecção de abandono silencioso (segundas 09:00 BRT) ────────────────
async function rotinaAbandonoSilencioso() {
  try {
    const hoje = new Date(Date.now() - 3*60*60*1000);
    const mesAtualStr = hoje.toISOString().slice(0,7);
    const mesAnterior = new Date(hoje.getFullYear(), hoje.getMonth()-1, 1).toISOString().slice(0,7);
    const dados = await getDados();

    const abandonos = dados.alunos.filter(a => {
      if (a.ativo !== 'SIM' || a.tipo_plano !== 'mensal') return false;
      const pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
      // Sem pagamento no mês atual E no anterior
      return !(pags[mesAtualStr] > 0) && !(pags[mesAnterior] > 0);
    });

    if (!abandonos.length) return;

    const linhas = abandonos.map(a =>
      '👻 *' + a.nome.split(' ').slice(0,2).join(' ') + '* — sem pagamento há 2+ meses'
    ).join('\n');

    await tgSend(TELEGRAM_CHAT_ID,
      '👻 *Possível abandono silencioso (' + abandonos.length + ')*\n\n' + linhas +
      '\n\n_Alunos mensais ativos sem pagamento em ' + mesAnterior + ' e ' + mesAtualStr + '. Considere contato ou inativação._');
    console.log('[rotina-abandono] detectados:', abandonos.length);
  } catch(e) { console.error('[rotina-abandono] erro:', e.message); }
}

// ── 3. Resumo semanal (sextas 20:00 BRT) com saldo ──────────────────────────
async function rotinaResumoSemanal() {
  try {
    const hoje = new Date(Date.now() - 3*60*60*1000);
    const mesAtualStr = hoje.toISOString().slice(0,7);
    const dados = await getDados();
    const ativos = dados.alunos.filter(a => a.ativo === 'SIM');

    // Receita do mês até agora — mesmo cálculo do site/buildContexto:
    // todos os alunos (inclui inativos que pagaram) menos rescisões do mês
    let recMesTotal = 0, nPagos = 0;
    dados.alunos.forEach(a => {
      const pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
      const pr = typeof a.pagamentos_rescisao==='string'?JSON.parse(a.pagamentos_rescisao||'{}'):(a.pagamentos_rescisao||{});
      if (pags[mesAtualStr] > 0) {
        recMesTotal += pags[mesAtualStr] - (pr[mesAtualStr]||0);
        if (a.ativo === 'SIM') nPagos++; // contador X/Y continua sobre ativos
      }
    });

    // Pagamentos dos últimos 7 dias (via historico_alteracoes tipo pagamento)
    const seteDiasAtras = new Date(hoje.getTime() - 7*86400000);
    let recebidosSemana = [];
    ativos.forEach(a => {
      (a.historico_alteracoes||[]).forEach(h => {
        if (h.tipo !== 'pagamento' || !h.data) return;
        const dp = h.data.split('/');
        if (dp.length !== 3) return;
        const dt = new Date(parseInt(dp[2]), parseInt(dp[1])-1, parseInt(dp[0]));
        if (dt >= seteDiasAtras) recebidosSemana.push(a.nome.split(' ')[0]);
      });
    });

    // Inadimplentes do mês
    const inadimplentes = ativos.filter(a => {
      const pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
      const diaV = parseInt(a.dia_vencimento||31);
      return !(pags[mesAtualStr] > 0) && diaV < hoje.getDate();
    });

    // Saldo Inter
    let saldoStr = '_indisponível_';
    try {
      const s = await Promise.race([
        interSaldo(),
        new Promise((_,r) => setTimeout(() => r(new Error('timeout')), 20000))
      ]);
      const disp = s?.disponivel ?? s?.saldoDisponivel ?? s?.disponível;
      if (disp !== undefined) saldoStr = brl(parseFloat(disp));
    } catch(e) { console.log('[resumo-semanal] saldo indisponível:', e.message); }

    await tgSend(TELEGRAM_CHAT_ID,
      '📊 *Resumo semanal — ' + hoje.toLocaleDateString('pt-BR') + '*\n\n' +
      '🏦 Saldo Inter: *' + saldoStr + '*\n' +
      '💰 Receita ' + mesAtualStr + ': *' + brl(recMesTotal) + '* (' + nPagos + '/' + ativos.length + ' pagos)\n' +
      '📥 Pagamentos na semana: ' + (recebidosSemana.length ? recebidosSemana.length + ' (' + [...new Set(recebidosSemana)].slice(0,8).join(', ') + ')' : 'nenhum') + '\n' +
      '🔴 Inadimplentes (venc. passado): ' + inadimplentes.length +
      (inadimplentes.length ? '\n   ' + inadimplentes.slice(0,10).map(a=>a.nome.split(' ')[0]).join(', ') : '') +
      '\n\n_Bom fim de semana!_ 🙌');
    console.log('[resumo-semanal] enviado');
  } catch(e) { console.error('[resumo-semanal] erro:', e.message); }
}

// ── 4. Fechamento mensal (dia 1º às 09:00 BRT) ──────────────────────────────
async function rotinaFechamentoMensal() {
  try {
    const hoje = new Date(Date.now() - 3*60*60*1000);
    const mesFechado = new Date(hoje.getFullYear(), hoje.getMonth()-1, 1);
    const mesFechadoStr = mesFechado.toISOString().slice(0,7);
    const mesAnterior2 = new Date(hoje.getFullYear(), hoje.getMonth()-2, 1).toISOString().slice(0,7);
    const dados = await getDados();
    const MESES_PT3 = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    // Receita do mês fechado e do anterior
    let recFechado = 0, recAnt = 0, nPagFechado = 0, inadimplentes = [];
    dados.alunos.forEach(a => {
      const pags = typeof a.pagamentos==='string'?JSON.parse(a.pagamentos||'{}'):(a.pagamentos||{});
      const pr = typeof a.pagamentos_rescisao==='string'?JSON.parse(a.pagamentos_rescisao||'{}'):(a.pagamentos_rescisao||{});
      if (pags[mesFechadoStr] > 0) { recFechado += pags[mesFechadoStr] - (pr[mesFechadoStr]||0); nPagFechado++; }
      if (pags[mesAnterior2] > 0) recAnt += pags[mesAnterior2] - (pr[mesAnterior2]||0);
      if (a.ativo === 'SIM' && !(pags[mesFechadoStr] > 0)) inadimplentes.push(a.nome.split(' ')[0]);
    });

    // Custos do mês fechado
    let custosTotal = 0;
    (dados.custos||[]).forEach(cu => {
      if ((cu.mes||'') === mesFechadoStr) custosTotal += parseFloat(cu.valor||0);
    });

    // Aulas Kelly do mês (horas x valor/hora)
    let kellyTotal = 0;
    const profKelly = (dados.professoras||[]).find(pr => (pr.nome||'').toLowerCase().includes('kelly'));
    const vhKelly = parseFloat(profKelly?.valor_hora || 35);
    (dados.aulas||[]).forEach(au => {
      if (au.prof_id === 'kelly' && (au.mes||'') === mesFechadoStr) {
        kellyTotal += (parseFloat(au.horas||au.vh||0)) * vhKelly;
      }
    });

    const varPct = recAnt > 0 ? Math.round(((recFechado-recAnt)/recAnt)*100) : 0;
    const varStr = varPct > 0 ? '+' + varPct + '%' : varPct + '%';
    const mesNome = MESES_PT3[mesFechado.getMonth()] + '/' + mesFechado.getFullYear();

    await tgSend(TELEGRAM_CHAT_ID,
      '📈 *Fechamento mensal — ' + mesNome + '*\n\n' +
      '💰 Receita: *' + brl(recFechado) + '* (' + varStr + ' vs mês anterior)\n' +
      '👥 Pagantes: ' + nPagFechado + '\n' +
      '💸 Custos lançados: ' + brl(custosTotal) + '\n' +
      '🧘 Aulas Kelly: ' + brl(kellyTotal) + '\n' +
      '🔴 Não pagaram: ' + inadimplentes.length +
      (inadimplentes.length ? ' (' + inadimplentes.slice(0,10).join(', ') + (inadimplentes.length>10?'...':'') + ')' : '') +
      '\n\n_Use o Relatório Contábil no site para detalhes completos._');
    console.log('[fechamento-mensal] enviado:', mesNome);
  } catch(e) { console.error('[fechamento-mensal] erro:', e.message); }
}


// ── Backup semanal: exporta JSON completo e envia no Telegram (dom 20h) ─────
async function tgSendJSONBuffer(chatId, jsonBuffer, filename, caption) {
  const https = require('https');
  const boundary = '----TGBoundary' + Date.now();
  const safeFilename = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const parts = [
    '--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + chatId,
    '--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + (caption||''),
    '--' + boundary + '\r\nContent-Disposition: form-data; name="document"; filename="' + safeFilename + '"\r\nContent-Type: application/json\r\n\r\n'
  ];
  const header = Buffer.from(parts.join('\r\n'));
  const footer = Buffer.from('\r\n--' + boundary + '--\r\n');
  const body = Buffer.concat([header, jsonBuffer, footer]);
  return new Promise((resolve, reject) => {
    const reqq = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + TELEGRAM_TOKEN + '/sendDocument',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    }, res => {
      let d = '';
      res.on('data', ch => d += ch);
      res.on('end', () => resolve(d));
    });
    reqq.on('error', reject);
    reqq.write(body);
    reqq.end();
  });
}

// Rotina (dom 20h / sob demanda): exporta JSON completo do sistema e envia como documento no Telegram.
async function rotinaBackupSemanal() {
  try {
    const dados = await getDados();
    // Buscar também a tabela changes (agenda, checkins, planos)
    let changes = {};
    try {
      const rCh = await sbGet('changes', 'select=data&id=eq.1');
      let chData = Array.isArray(rCh) && rCh[0] && rCh[0].data;
      if (typeof chData === 'string') { try { chData = JSON.parse(chData); } catch { chData = {}; } }
      changes = chData || {};
    } catch(e) { console.log('[backup] changes indisponível:', e.message); }

    const backup = {
      versao: 'bot-' + BOT_VERSION,
      exportado: new Date().toISOString(),
      alunos: dados.alunos,
      custos: dados.custos,
      aulas: dados.aulas,
      professoras: dados.professoras || [],
      agenda: changes.agenda || {},
      checkins: changes.checkins || {},
      planos: changes.planos || {},
      planos_historico: changes.planos_historico || [],
      rescisao_seq: changes.rescisao_seq || 0
    };

    const json = Buffer.from(JSON.stringify(backup, null, 1));
    const dataStr = new Date(Date.now() - 3*60*60*1000).toISOString().slice(0,10);
    const nome = 'LCA_backup_' + dataStr + '.json';
    const tamanhoKB = Math.round(json.length / 1024);

    await tgSendJSONBuffer(TELEGRAM_CHAT_ID, json, nome,
      '💾 Backup semanal automático — ' + dataStr + ' (' + dados.alunos.length + ' alunos, ' + tamanhoKB + ' KB)');
    console.log('[backup-semanal] enviado:', nome, tamanhoKB + 'KB');
  } catch(e) {
    console.error('[backup-semanal] erro:', e.message);
    try { await tgSend(TELEGRAM_CHAT_ID, '⚠️ Falha no backup semanal automático: ' + e.message.slice(0,100)); } catch {}
  }
}

// ── Agendador central das rotinas ────────────────────────────────────────────
function agendarRotinasAutomaticas() {
  async function checarRotinas() {
    const brNow = new Date(Date.now() - 3*60*60*1000);
    const hora = brNow.getHours();
    const min = brNow.getMinutes();
    const diaSemana = brNow.getDay(); // 0=dom, 5=sexta, 1=segunda
    const diaMes = brNow.getDate();

    // 09:00 — alerta de inadimplência (diário)
    if (hora === 9 && min < 5 && !_jaExecutouHoje('inadimplencia')) {
      await rotinaAlertaInadimplencia();
    }
    // 09:00 — planos vencendo (diário, alerta em 7/3/0 dias)
    if (hora === 9 && min < 5 && !_jaExecutouHoje('planosVencendo')) {
      await rotinaPlanosVencendo();
    }
    // 09:00 segundas — abandono silencioso (semanal)
    if (hora === 9 && min < 5 && diaSemana === 1 && !_jaExecutouHoje('abandono')) {
      await rotinaAbandonoSilencioso();
    }
    // 20:00 sextas — resumo semanal com saldo
    if (hora === 20 && min < 5 && diaSemana === 5 && !_jaExecutouHoje('resumoSemanal')) {
      await rotinaResumoSemanal();
    }
    // 09:00 dia 1º — fechamento mensal
    if (hora === 9 && min < 5 && diaMes === 1 && !_jaExecutouHoje('fechamentoMensal')) {
      await rotinaFechamentoMensal();
    }
    // 20:00 domingos — backup semanal via Telegram
    if (hora === 20 && min < 5 && diaSemana === 0 && !_jaExecutouHoje('backupSemanal')) {
      await rotinaBackupSemanal();
    }
  }
  setInterval(checarRotinas, 4 * 60 * 1000); // a cada 4 min
  console.log('Rotinas automáticas agendadas: inadimplência (9h), planos vencendo (9h), abandono (seg 9h), resumo semanal (sex 20h), fechamento (dia 1º 9h), backup (dom 20h)');
}


// Agenda o envio diário (8h BRT) das mensagens de aniversariantes do dia.
function agendarRotinaAniversarios() {
  // Verificar a cada hora se chegou às 8h (horário de Brasília = UTC-3)
  async function checar() {
    const agora = new Date();
    const brNow = new Date(agora.getTime() - 3*60*60*1000);
    const horaBrasilia = brNow.getHours();
    const min = brNow.getMinutes();
    if (horaBrasilia === 8 && min < 5) {
      await enviarAniversariantesHoje();
    }
  }
  // Verificar a cada 5 minutos
  setInterval(checar, 5 * 60 * 1000);
  // Verificar também na inicialização (para não perder se o bot reiniciar às 8h)
  checar();
  console.log('Rotina de aniversários agendada (08:00 BRT diariamente)');
}

const ctx = {}; // contexto por chatId: { intencao, aluno_id, aluno_nome, aguardando }

// ── Main ────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== LCA Bot v' + BOT_VERSION + ' iniciado ✓ ===');
  console.log('Versão: ' + BOT_VERSION + ' | ' + new Date().toLocaleString('pt-BR', {timeZone:'America/Sao_Paulo'}));
  let offset = 0;
  try {
    const init = await req('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getUpdates?offset=-1&limit=1&timeout=0', 'GET', {}, null);
    if (init?.result?.length) offset = init.result[init.result.length-1].update_id+1;
    await req('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getUpdates?offset=' + offset + '&limit=1&timeout=0', 'GET', {}, null);
    console.log('Fila limpa. Offset:', offset);
  } catch(e) { console.log('Init aviso:', e.message); }

  const processados = {};

  // Servidor HTTP para o Render + endpoint /ping para keep-alive (UptimeRobot)
  require('http').createServer(async (req, res) => {
    if (req.url === '/ping') {
      res.writeHead(200, {'Content-Type':'text/plain'});
      res.end('pong');

    } else if (req.url === '/webhook-inter' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          console.log('[WEBHOOK-INTER]', JSON.stringify(payload).slice(0, 300));

          // Payload do Inter: campos na raiz ou em cobranca/pagamento
          const evento   = payload?.evento || payload?.tipo || payload?.situacao || '';
          const seuNum   = payload?.seuNumero || payload?.cobranca?.seuNumero || '';
          const nossoNum = payload?.nossoNumero || payload?.boleto?.nossoNumero || '';
          const valorPago = parseFloat(
            payload?.valorTotalRecebido || payload?.valor || payload?.valorPago ||
            payload?.cobranca?.valorNominal || payload?.pagamento?.valorPago || 0
          );
          const dataPag = payload?.dataLiquidacao || payload?.dataPagamento ||
            (payload?.dataHoraSituacao || '').slice(0,10) || new Date().toISOString().slice(0,10);

          // seuNumero: LCA-{id}-{mes} (bot) ou número puro = id (boletos antigos)
          const psn = parseSeuNumero(seuNum);
          const vencWebhook = payload?.dataVencimento || payload?.cobranca?.dataVencimento || '';
          const mesInferido = psn.mes || vencWebhook.slice(0,7) || dataPag.slice(0,7);
          const eventoValido = !evento || evento.includes('PAGO') || evento.includes('LIQUIDADO') || evento.includes('RECEBIDO');

          if (!psn.alunoId || !mesInferido) {
            console.log('[WEBHOOK-INTER] seuNum não reconhecido:', seuNum, '| nossoNum:', nossoNum);
          } else if (!eventoValido) {
            console.log('[WEBHOOK-INTER] Evento ignorado:', evento);
          } else {
            const alunoId = psn.alunoId;
            const mes = mesInferido;

            // Se valor não veio no webhook, buscar na API Inter
            let valorFinal = valorPago;
            if (!valorFinal) {
              try {
                const token = await interGetToken('boleto-cobranca.read');
                const det = await interReq('/cobranca/v3/cobrancas/' + seuNum, 'GET', null, token);
                valorFinal = parseFloat(det?.cobranca?.valorNominal || det?.valorNominal || 0);
                console.log('[WEBHOOK-INTER] Valor buscado na API:', valorFinal);
              } catch(e) { console.log('[WEBHOOK] erro ao buscar valor:', e.message); }
            }

            if (!valorFinal) {
              console.log('[WEBHOOK-INTER] Sem valor — ignorado. seuNum=' + seuNum);
            } else {
              const rAlunos = await sbGet('alunos', 'select=id,nome,pagamentos,pagamentos_pendentes,historico_alteracoes&id=eq.' + alunoId);
              const aluno = (Array.isArray(rAlunos) ? rAlunos[0] : rAlunos?.data?.[0]);
              if (!aluno) {
                console.log('[WEBHOOK-INTER] Aluno ' + alunoId + ' não encontrado');
              } else {
                const pags = typeof aluno.pagamentos === 'string' ? JSON.parse(aluno.pagamentos || '{}') : (aluno.pagamentos || {});
                if (pags[mes] && pags[mes] > 0) {
                  console.log('[WEBHOOK-INTER] Pagamento já existe para aluno ' + alunoId + ' mes ' + mes + ' - ignorado');
                } else {
                  pags[mes] = valorFinal;
                  const pend = typeof aluno.pagamentos_pendentes === 'string' ? JSON.parse(aluno.pagamentos_pendentes || '{}') : (aluno.pagamentos_pendentes || {});
                  const tinhaPend = (pend[mes] || 0) > 0;
                  if (tinhaPend) delete pend[mes];
                  const hist = aluno.historico_alteracoes || [];
                  hist.push({ data: new Date().toLocaleDateString('pt-BR'), tipo: 'pagamento',
                    desc: 'Pagamento ' + mes + ' via boleto Inter (automático): ' + brl(valorFinal) });
                  const patch = { pagamentos: pags, historico_alteracoes: hist };
                  if (tinhaPend) patch.pagamentos_pendentes = pend;
                  await sbPatch('alunos', 'id=eq.' + alunoId, patch);
                  try {
                    await sbPatch('boletos', 'aluno_id=eq.' + alunoId + '&mes=eq.' + mes + '&status=eq.aberto',
                      { status: 'pago', pago_em: new Date().toISOString() });
                  } catch(e) { console.error('[webhook] erro ao marcar boleto pago:', e.message); }
                  const chatId = TELEGRAM_CHAT_ID;
                  if (chatId) {
                    await logOp('boleto_pago_webhook', aluno.nome + ' - ' + mes, alunoId, valorFinal, mes, {dataPagamento: dataPag});
                    await tgSend(chatId, '🏦 *Pagamento confirmado automaticamente!*\n\n👤 ' + aluno.nome + '\n💰 ' + brl(valorFinal) + '\n📅 ' + mes + ' - pago em ' + dataPag.split('-').reverse().join('/') + '\n_Boleto Inter baixado automaticamente._');
                  }
                  console.log('[WEBHOOK-INTER] Pagamento confirmado: aluno ' + alunoId + ' mes ' + mes + ' valor ' + valorFinal);
                }
              }
            }
          }
        } catch(e) {
          console.error('[WEBHOOK-INTER] Erro:', e.message);
        }
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end('{"ok":true}');
      });

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

    } else if (req.url === '/comando' && req.method === 'POST') {
      // CORS para o site no Netlify
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Comando-Token');
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          // Segurança: exigir token secreto compartilhado (env COMANDO_TOKEN).
          // Sem isso, qualquer um poderia POSTar comandos executados como se fosse o dono.
          const tokenRecebido = req.headers['x-comando-token'] || payload.token || '';
          if (!COMANDO_TOKEN || tokenRecebido !== COMANDO_TOKEN) {
            console.log('[COMANDO SITE] token inválido — negado');
            res.writeHead(403, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ ok: false, erro: 'não autorizado' }));
            return;
          }
          const comando = payload.comando || '';
          const alunoId = payload.aluno_id;
          console.log('[COMANDO SITE]', comando, 'aluno_id:', alunoId);
          if (!comando) {
            res.writeHead(400, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ ok: false, erro: 'comando não informado' }));
            return;
          }
          // Processar SEMPRE como o dono (chatId fixo do env, nunca do payload — evita injeção de chatId)
          const msgFake = { text: comando, chat: { id: TELEGRAM_CHAT_ID }, from: { username: 'site', id: TELEGRAM_CHAT_ID } };
          processar(msgFake).catch(e => console.error('[COMANDO SITE] erro:', e.message));
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: true, mensagem: 'Comando recebido - verifique o Telegram' }));
        } catch(e) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });

    } else if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Comando-Token');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(200, {'Content-Type':'text/plain'});
      res.end('LCA Bot v' + BOT_VERSION + ' OK - ' + new Date().toLocaleString('pt-BR'));
    }
  }).listen(process.env.PORT||3000, () => console.log('HTTP OK - /ping disponível'));
  agendarRotinaAniversarios();
  // Verificar fila de boletos a cada 2 minutos
  setInterval(processarFilaBoletos, 2 * 60 * 1000);
  processarFilaBoletos(); // verificar imediatamente na inicialização
  // Verificar boletos pagos no Inter a cada 5 minutos (independente do webhook)
  setInterval(verificarBoletosPagosInter, 5 * 60 * 1000);
  setTimeout(verificarBoletosPagosInter, 30000); // primeira verificação 30s após iniciar
  // Detectar Pix de alunos no extrato a cada 30 minutos
  setInterval(rotinaDetectarPixAlunos, 30 * 60 * 1000);
  setTimeout(rotinaDetectarPixAlunos, 60000); // primeira verificação 60s após iniciar
  // Rotinas automáticas: inadimplência, planos vencendo, abandono, resumo semanal, fechamento mensal
  agendarRotinasAutomaticas();

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

// ── Proteção contra crash: captura exceções não tratadas para o bot não morrer ──
// (Render reinicia o processo em caso de crash, mas isso causa downtime e perda do offset)
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack?.slice(0,300));
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', (reason && reason.message) || reason);
});

main();
