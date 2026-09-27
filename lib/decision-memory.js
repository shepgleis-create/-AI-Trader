import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
let schemaPromise = null;

function connectionString(){
  return String(
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.NEON_DATABASE_URL ||
    ''
  ).trim();
}

export function decisionMemoryConfigured(){
  return Boolean(connectionString());
}

function pool(){
  const url = connectionString();
  if(!url) return null;
  if(!globalThis.__aiTraderPgPool){
    globalThis.__aiTraderPgPool = new Pool({
      connectionString:url,
      max:2,
      idleTimeoutMillis:10000,
      connectionTimeoutMillis:5000
    });
  }
  return globalThis.__aiTraderPgPool;
}

export function newDecisionCycleId(prefix='cycle'){
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

async function ensureSchema(){
  if(!decisionMemoryConfigured()) return false;
  if(schemaPromise) return schemaPromise;

  schemaPromise=(async()=>{
    const db=pool();
    await db.query(`
      CREATE TABLE IF NOT EXISTS decision_cycles (
        cycle_id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        origin TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'PAPER',
        execution_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        decision_source TEXT,
        model TEXT,
        decision_action TEXT,
        decision_symbol TEXT,
        decision_confidence DOUBLE PRECISION,
        decision_rationale TEXT,
        stage TEXT,
        regime JSONB,
        account_risk JSONB,
        portfolio_risk JSONB,
        risk JSONB,
        intraday JSONB,
        execution JSONB,
        meta JSONB
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS decision_candidates (
        id BIGSERIAL PRIMARY KEY,
        cycle_id TEXT NOT NULL REFERENCES decision_cycles(cycle_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        symbol TEXT NOT NULL,
        reference_price DOUBLE PRECISION,
        scanner_score DOUBLE PRECISION,
        readiness_score DOUBLE PRECISION,
        readiness_grade TEXT,
        selected BOOLEAN NOT NULL DEFAULT FALSE,
        event_risk TEXT,
        candidate JSONB,
        context JSONB,
        outcome_1d DOUBLE PRECISION,
        outcome_3d DOUBLE PRECISION,
        outcome_5d DOUBLE PRECISION,
        close_1d DOUBLE PRECISION,
        close_3d DOUBLE PRECISION,
        close_5d DOUBLE PRECISION,
        outcome_1d_at TIMESTAMPTZ,
        outcome_3d_at TIMESTAMPTZ,
        outcome_5d_at TIMESTAMPTZ,
        UNIQUE(cycle_id, symbol)
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS decision_candidates_pending_idx
      ON decision_candidates(created_at)
      WHERE outcome_5d IS NULL;
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS decision_candidates_symbol_idx
      ON decision_candidates(symbol, created_at DESC);
    `);

    return true;
  })().catch(error=>{
    schemaPromise=null;
    throw error;
  });

  return schemaPromise;
}

function json(v){
  return v == null ? null : JSON.stringify(v);
}

function compactCandidate(c){
  if(!c) return null;
  return {
    symbol:c.symbol,
    price:Number(c.price||0)||null,
    score:Number(c.score||0)||null,
    setup:c.setup||null,
    setup_type:c.setup_type||null,
    momentum_5d:c.momentum_5d ?? null,
    momentum_20d:c.momentum_20d ?? null,
    relative_strength_20d:c.relative_strength_20d ?? null,
    rs_percentile:c.rs_percentile ?? null,
    risk_adjusted_momentum:c.risk_adjusted_momentum ?? null,
    risk_adjusted_momentum_percentile:c.risk_adjusted_momentum_percentile ?? null,
    rsi14:c.rsi14 ?? null,
    atr_pct:c.atr_pct ?? null,
    volatility_20d:c.volatility_20d ?? null,
    avg_dollar_volume_20d:c.avg_dollar_volume_20d ?? null,
    spread_pct:c.spread_pct ?? null,
    beta_60d:c.beta_60d ?? null,
    sector_proxy:c.sector_proxy ?? null,
    sector_correlation:c.sector_correlation ?? null,
    sector_strength_percentile:c.sector_strength_percentile ?? null,
    sector_rank:c.sector_rank ?? null,
    gap_pct:c.gap_pct ?? null,
    move_from_open_pct:c.move_from_open_pct ?? null,
    day_change:c.day_change ?? null,
    historical_edge:c.historical_edge ?? null,
    data_age_seconds:c.data_age_seconds ?? null
  };
}

export async function saveDecisionMemory({
  cycle_id,
  origin,
  mode='PAPER',
  execution_enabled=false,
  source=null,
  model=null,
  decision=null,
  stage=null,
  regime=null,
  account_risk=null,
  portfolio_risk=null,
  risk=null,
  intraday=null,
  execution=null,
  meta=null,
  candidates=[],
  candidate_context={},
  readiness_by_symbol={}
}){
  if(!decisionMemoryConfigured()){
    return {saved:false,configured:false};
  }

  try{
    await ensureSchema();
    const db=pool();
    const cycleId=cycle_id||newDecisionCycleId(origin||'cycle');

    await db.query('BEGIN');
    try{
      await db.query(`
        INSERT INTO decision_cycles (
          cycle_id, origin, mode, execution_enabled,
          decision_source, model, decision_action, decision_symbol,
          decision_confidence, decision_rationale, stage,
          regime, account_risk, portfolio_risk, risk, intraday, execution, meta
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          $12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb
        )
        ON CONFLICT (cycle_id) DO UPDATE SET
          decision_source=EXCLUDED.decision_source,
          model=EXCLUDED.model,
          decision_action=EXCLUDED.decision_action,
          decision_symbol=EXCLUDED.decision_symbol,
          decision_confidence=EXCLUDED.decision_confidence,
          decision_rationale=EXCLUDED.decision_rationale,
          stage=EXCLUDED.stage,
          regime=EXCLUDED.regime,
          account_risk=EXCLUDED.account_risk,
          portfolio_risk=EXCLUDED.portfolio_risk,
          risk=EXCLUDED.risk,
          intraday=EXCLUDED.intraday,
          execution=EXCLUDED.execution,
          meta=EXCLUDED.meta
      `,[
        cycleId, origin||'unknown', mode, Boolean(execution_enabled),
        source, model, decision?.action||null, decision?.symbol||null,
        Number.isFinite(Number(decision?.confidence))?Number(decision.confidence):null,
        decision?.rationale||null, stage,
        json(regime), json(account_risk), json(portfolio_risk), json(risk),
        json(intraday), json(execution), json(meta)
      ]);

      for(const c0 of (Array.isArray(candidates)?candidates:[])){
        const c=compactCandidate(c0);
        if(!c?.symbol) continue;

        const context=candidate_context?.[c.symbol]||null;
        const readiness=readiness_by_symbol?.[c.symbol]||c0?.readiness||null;

        await db.query(`
          INSERT INTO decision_candidates (
            cycle_id, symbol, reference_price, scanner_score,
            readiness_score, readiness_grade, selected, event_risk,
            candidate, context
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
          ON CONFLICT (cycle_id, symbol) DO UPDATE SET
            reference_price=EXCLUDED.reference_price,
            scanner_score=EXCLUDED.scanner_score,
            readiness_score=EXCLUDED.readiness_score,
            readiness_grade=EXCLUDED.readiness_grade,
            selected=EXCLUDED.selected,
            event_risk=EXCLUDED.event_risk,
            candidate=EXCLUDED.candidate,
            context=EXCLUDED.context
        `,[
          cycleId,
          c.symbol,
          Number(c.price)||null,
          Number.isFinite(Number(c.score))?Number(c.score):null,
          Number.isFinite(Number(readiness?.score))?Number(readiness.score):null,
          readiness?.grade||null,
          decision?.symbol===c.symbol,
          context?.risk?.level||null,
          json(c),
          json(context)
        ]);
      }

      await db.query('COMMIT');
      return {saved:true,configured:true,cycle_id:cycleId};
    }catch(error){
      await db.query('ROLLBACK');
      throw error;
    }
  }catch(error){
    return {
      saved:false,
      configured:true,
      error:String(error?.message||'Decision memory write failed').slice(0,300)
    };
  }
}

export async function getDecisionMemoryStatus(){
  if(!decisionMemoryConfigured()){
    return {
      configured:false,
      backend:'POSTGRES',
      expected_env:['DATABASE_URL','POSTGRES_URL','POSTGRES_PRISMA_URL','NEON_DATABASE_URL']
    };
  }

  await ensureSchema();
  const db=pool();

  const [counts,actions,outcomes,recent]=await Promise.all([
    db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM decision_cycles) AS cycles,
        (SELECT COUNT(*)::int FROM decision_candidates) AS candidates
    `),
    db.query(`
      SELECT COALESCE(decision_action,'UNKNOWN') AS action, COUNT(*)::int AS count
      FROM decision_cycles
      GROUP BY 1
      ORDER BY count DESC
    `),
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome_1d IS NOT NULL)::int AS outcome_1d_count,
        COUNT(*) FILTER (WHERE outcome_3d IS NOT NULL)::int AS outcome_3d_count,
        COUNT(*) FILTER (WHERE outcome_5d IS NOT NULL)::int AS outcome_5d_count,
        AVG(outcome_1d) FILTER (WHERE outcome_1d IS NOT NULL) AS avg_1d,
        AVG(outcome_3d) FILTER (WHERE outcome_3d IS NOT NULL) AS avg_3d,
        AVG(outcome_5d) FILTER (WHERE outcome_5d IS NOT NULL) AS avg_5d,
        AVG(outcome_5d) FILTER (WHERE outcome_5d IS NOT NULL AND selected=TRUE) AS selected_avg_5d,
        AVG(outcome_5d) FILTER (WHERE outcome_5d IS NOT NULL AND selected=FALSE) AS skipped_avg_5d
      FROM decision_candidates
    `),
    db.query(`
      SELECT
        cycle_id, created_at, origin, decision_source, decision_action,
        decision_symbol, decision_confidence, stage
      FROM decision_cycles
      ORDER BY created_at DESC
      LIMIT 12
    `)
  ]);

  return {
    configured:true,
    backend:'POSTGRES',
    counts:counts.rows[0]||{},
    actions:actions.rows,
    outcomes:outcomes.rows[0]||{},
    recent:recent.rows
  };
}

export async function getPendingOutcomeCandidates(limit=80){
  if(!decisionMemoryConfigured()) return [];
  await ensureSchema();
  const db=pool();
  const r=await db.query(`
    SELECT
      dc.id, dc.cycle_id, dc.symbol, dc.reference_price, dc.created_at,
      dc.outcome_1d, dc.outcome_3d, dc.outcome_5d
    FROM decision_candidates dc
    WHERE dc.reference_price > 0
      AND dc.outcome_5d IS NULL
      AND dc.created_at < NOW() - INTERVAL '16 hours'
    ORDER BY dc.created_at ASC
    LIMIT $1
  `,[Math.max(1,Math.min(250,Number(limit)||80))]);
  return r.rows;
}

export async function updateCandidateOutcomes(id,updates={}){
  if(!decisionMemoryConfigured()) return {updated:false};

  await ensureSchema();
  const db=pool();

  const fields=[];
  const values=[];
  let i=1;

  for(const key of [
    'outcome_1d','outcome_3d','outcome_5d',
    'close_1d','close_3d','close_5d',
    'outcome_1d_at','outcome_3d_at','outcome_5d_at'
  ]){
    if(updates[key]===undefined) continue;
    fields.push(`${key}=$${i++}`);
    values.push(updates[key]);
  }

  if(!fields.length) return {updated:false};
  values.push(id);

  await db.query(
    `UPDATE decision_candidates SET ${fields.join(', ')} WHERE id=$${i}`,
    values
  );

  return {updated:true};
}

export async function getDecisionAttribution(){
  if(!decisionMemoryConfigured()) return {configured:false};
  await ensureSchema();
  const db=pool();

  const [segments,stages,riskRules,intradayRules]=await Promise.all([
    db.query(`
      SELECT
        COALESCE(dc.selected,FALSE) AS selected,
        COALESCE(dc.event_risk,'UNKNOWN') AS event_risk,
        CASE
          WHEN dc.readiness_score >= 90 THEN '90-100'
          WHEN dc.readiness_score >= 80 THEN '80-89'
          WHEN dc.readiness_score >= 70 THEN '70-79'
          WHEN dc.readiness_score >= 60 THEN '60-69'
          ELSE '<60'
        END AS readiness_bucket,
        COUNT(*)::int AS samples,
        AVG(dc.outcome_1d) AS avg_1d,
        AVG(dc.outcome_3d) AS avg_3d,
        AVG(dc.outcome_5d) AS avg_5d
      FROM decision_candidates dc
      WHERE dc.outcome_1d IS NOT NULL
      GROUP BY 1,2,3
      ORDER BY samples DESC
    `),
    db.query(`
      SELECT
        COALESCE(c.stage,'UNKNOWN') AS stage,
        COUNT(*)::int AS cycles,
        COUNT(dc.id)::int AS candidate_samples,
        AVG(dc.outcome_1d) AS avg_1d,
        AVG(dc.outcome_3d) AS avg_3d,
        AVG(dc.outcome_5d) AS avg_5d
      FROM decision_cycles c
      LEFT JOIN decision_candidates dc
        ON dc.cycle_id=c.cycle_id
        AND (
          (c.decision_symbol IS NOT NULL AND c.decision_symbol<>'' AND dc.symbol=c.decision_symbol)
          OR ((c.decision_symbol IS NULL OR c.decision_symbol='') AND dc.selected=FALSE)
        )
      GROUP BY 1
      ORDER BY cycles DESC
    `),
    db.query(`
      SELECT
        reason,
        COUNT(*)::int AS samples,
        AVG(dc.outcome_1d) AS avg_1d,
        AVG(dc.outcome_3d) AS avg_3d,
        AVG(dc.outcome_5d) AS avg_5d
      FROM decision_cycles c
      JOIN decision_candidates dc
        ON dc.cycle_id=c.cycle_id
        AND dc.symbol=c.decision_symbol
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(c.risk->'reasons')='array' THEN c.risk->'reasons'
          ELSE '[]'::jsonb
        END
      ) AS reason
      WHERE dc.outcome_1d IS NOT NULL
      GROUP BY reason
      ORDER BY samples DESC
    `),
    db.query(`
      SELECT
        reason,
        COUNT(*)::int AS samples,
        AVG(dc.outcome_1d) AS avg_1d,
        AVG(dc.outcome_3d) AS avg_3d,
        AVG(dc.outcome_5d) AS avg_5d
      FROM decision_cycles c
      JOIN decision_candidates dc
        ON dc.cycle_id=c.cycle_id
        AND dc.symbol=c.decision_symbol
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(c.intraday->'reasons')='array' THEN c.intraday->'reasons'
          ELSE '[]'::jsonb
        END
      ) AS reason
      WHERE dc.outcome_1d IS NOT NULL
      GROUP BY reason
      ORDER BY samples DESC
    `)
  ]);

  return {
    configured:true,
    segments:segments.rows,
    stages:stages.rows,
    risk_rules:riskRules.rows,
    intraday_rules:intradayRules.rows
  };
}
