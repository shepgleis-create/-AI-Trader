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

    await db.query(`
      CREATE TABLE IF NOT EXISTS multi_asset_decisions (
        id BIGSERIAL PRIMARY KEY,
        decision_id TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        origin TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'PAPER',
        shadow BOOLEAN NOT NULL DEFAULT TRUE,
        execution BOOLEAN NOT NULL DEFAULT FALSE,
        selected_lane TEXT NOT NULL DEFAULT 'SKIP',
        symbol TEXT,
        contract TEXT,
        confidence DOUBLE PRECISION,
        rationale TEXT,
        model TEXT,
        model_fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
        hard_risk_clear BOOLEAN,
        hard_locks JSONB,
        lanes JSONB,
        account_risk JSONB,
        portfolio_risk JSONB,
        execution_meta JSONB,
        outcome JSONB,
        meta JSONB
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS multi_asset_decisions_created_idx
      ON multi_asset_decisions(created_at DESC);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS multi_asset_decisions_lane_idx
      ON multi_asset_decisions(selected_lane, created_at DESC);
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS research_challengers (
        experiment_id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source_recommendation_id TEXT NOT NULL,
        title TEXT NOT NULL,
        parameter_type TEXT NOT NULL,
        config JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        minimum_1d INTEGER NOT NULL DEFAULT 20,
        minimum_5d INTEGER NOT NULL DEFAULT 10,
        auto_apply BOOLEAN NOT NULL DEFAULT FALSE,
        meta JSONB
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS research_challengers_status_idx
      ON research_challengers(status, created_at DESC);
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS research_challenger_observations (
        id BIGSERIAL PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES research_challengers(experiment_id) ON DELETE CASCADE,
        decision_id TEXT NOT NULL REFERENCES multi_asset_decisions(decision_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        affected BOOLEAN NOT NULL DEFAULT FALSE,
        baseline_action TEXT NOT NULL,
        challenger_action TEXT NOT NULL,
        baseline_symbol TEXT,
        challenger_symbol TEXT,
        baseline_contract TEXT,
        challenger_contract TEXT,
        confidence DOUBLE PRECISION,
        context JSONB,
        baseline_return_1d DOUBLE PRECISION,
        challenger_return_1d DOUBLE PRECISION,
        delta_1d DOUBLE PRECISION,
        baseline_return_5d DOUBLE PRECISION,
        challenger_return_5d DOUBLE PRECISION,
        delta_5d DOUBLE PRECISION,
        UNIQUE(experiment_id, decision_id)
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS research_challenger_obs_exp_idx
      ON research_challenger_observations(experiment_id, created_at DESC);
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


export async function saveMultiAssetDecision({
  decision_id,
  origin='multi_asset_router',
  mode='PAPER',
  shadow=true,
  execution=false,
  decision={},
  hard_risk_clear=null,
  hard_locks=[],
  lanes={},
  account_risk=null,
  portfolio_risk=null,
  execution_meta=null,
  outcome=null,
  meta=null
}={}){
  if(!decisionMemoryConfigured()) return {saved:false,configured:false};

  try{
    await ensureSchema();
    const db=pool();
    const id=decision_id||newDecisionCycleId(shadow?'shadow':'multi');
    const lane=String(decision?.action||'SKIP');
    const symbol=String(decision?.symbol||'')||null;
    const contract=String(decision?.contract||'')||null;
    const confidence=Number(decision?.confidence);

    await db.query(`
      INSERT INTO multi_asset_decisions (
        decision_id, origin, mode, shadow, execution,
        selected_lane, symbol, contract, confidence, rationale,
        model, model_fallback_used, hard_risk_clear, hard_locks,
        lanes, account_risk, portfolio_risk, execution_meta, outcome, meta
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,
        $18::jsonb,$19::jsonb,$20::jsonb
      )
      ON CONFLICT (decision_id) DO UPDATE SET
        selected_lane=EXCLUDED.selected_lane,
        symbol=EXCLUDED.symbol,
        contract=EXCLUDED.contract,
        confidence=EXCLUDED.confidence,
        rationale=EXCLUDED.rationale,
        model=EXCLUDED.model,
        model_fallback_used=EXCLUDED.model_fallback_used,
        hard_risk_clear=EXCLUDED.hard_risk_clear,
        hard_locks=EXCLUDED.hard_locks,
        lanes=EXCLUDED.lanes,
        account_risk=EXCLUDED.account_risk,
        portfolio_risk=EXCLUDED.portfolio_risk,
        execution_meta=EXCLUDED.execution_meta,
        outcome=COALESCE(EXCLUDED.outcome,multi_asset_decisions.outcome),
        meta=EXCLUDED.meta
    `,[
      id,origin,mode,Boolean(shadow),Boolean(execution),
      lane,symbol,contract,Number.isFinite(confidence)?confidence:null,
      String(decision?.rationale||'').slice(0,2000)||null,
      decision?.model||null,Boolean(decision?.model_fallback_used),
      hard_risk_clear==null?null:Boolean(hard_risk_clear),
      json(Array.isArray(hard_locks)?hard_locks:[]),
      json(lanes||{}),json(account_risk),json(portfolio_risk),
      json(execution_meta),json(outcome),json(meta)
    ]);

    return {saved:true,configured:true,decision_id:id};
  }catch(error){
    return {
      saved:false,
      configured:true,
      error:String(error?.message||'Multi-asset memory write failed').slice(0,300)
    };
  }
}

export async function getMultiAssetMemoryReport(limit=20){
  if(!decisionMemoryConfigured()) return {configured:false};

  await ensureSchema();
  const db=pool();
  const safeLimit=Math.max(1,Math.min(100,Number(limit)||20));

  const [counts,lanes,models,recent]=await Promise.all([
    db.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE shadow=TRUE)::int AS shadow,
        COUNT(*) FILTER (WHERE execution=TRUE)::int AS executions,
        COUNT(*) FILTER (WHERE selected_lane='SKIP')::int AS skips,
        AVG(confidence) FILTER (WHERE confidence IS NOT NULL) AS avg_confidence,
        COUNT(*) FILTER (WHERE model_fallback_used=TRUE)::int AS model_fallbacks
      FROM multi_asset_decisions
    `),
    db.query(`
      SELECT selected_lane AS lane, COUNT(*)::int AS count,
             AVG(confidence) FILTER (WHERE confidence IS NOT NULL) AS avg_confidence
      FROM multi_asset_decisions
      GROUP BY selected_lane
      ORDER BY count DESC, selected_lane
    `),
    db.query(`
      SELECT COALESCE(model,'UNKNOWN') AS model, COUNT(*)::int AS count
      FROM multi_asset_decisions
      GROUP BY 1
      ORDER BY count DESC
    `),
    db.query(`
      SELECT
        decision_id, created_at, origin, shadow, execution,
        selected_lane, symbol, contract, confidence, rationale,
        model, model_fallback_used, hard_risk_clear, hard_locks
      FROM multi_asset_decisions
      ORDER BY created_at DESC
      LIMIT $1
    `,[safeLimit])
  ]);

  return {
    configured:true,
    counts:counts.rows[0]||{},
    by_lane:lanes.rows,
    by_model:models.rows,
    recent:recent.rows
  };
}


export async function getPendingMultiAssetOutcomes(limit=80){
  if(!decisionMemoryConfigured()) return [];
  await ensureSchema();
  const db=pool();
  const r=await db.query(`
    SELECT
      decision_id, created_at, selected_lane, symbol, contract,
      confidence, lanes, outcome, origin, shadow
    FROM multi_asset_decisions
    WHERE created_at < NOW() - INTERVAL '55 minutes'
      AND (
        outcome IS NULL
        OR NOT (outcome ? 'complete_5d')
        OR COALESCE((outcome->>'complete_5d')::boolean,FALSE)=FALSE
      )
    ORDER BY created_at ASC
    LIMIT $1
  `,[Math.max(1,Math.min(200,Number(limit)||80))]);
  return r.rows;
}

export async function updateMultiAssetOutcome(decisionId,outcome){
  if(!decisionMemoryConfigured()) return {updated:false,configured:false};
  await ensureSchema();
  const db=pool();
  await db.query(`
    UPDATE multi_asset_decisions
    SET outcome=$2::jsonb
    WHERE decision_id=$1
  `,[decisionId,json(outcome)]);
  return {updated:true,configured:true};
}

export async function getMultiAssetOutcomeReport(){
  if(!decisionMemoryConfigured()) return {configured:false};
  await ensureSchema();
  const db=pool();

  const [summary,byLane,recent]=await Promise.all([
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome IS NOT NULL)::int AS graded,
        COUNT(*) FILTER (WHERE outcome ? 'h1')::int AS h1_graded,
        COUNT(*) FILTER (WHERE outcome ? 'd1')::int AS d1_graded,
        COUNT(*) FILTER (WHERE outcome ? 'd3')::int AS d3_graded,
        COUNT(*) FILTER (WHERE outcome ? 'd5')::int AS d5_graded,
        AVG((outcome->'d1'->>'chosen_return')::double precision)
          FILTER (WHERE outcome->'d1'->>'chosen_return' IS NOT NULL) AS avg_chosen_1d,
        AVG((outcome->'d5'->>'chosen_return')::double precision)
          FILTER (WHERE outcome->'d5'->>'chosen_return' IS NOT NULL) AS avg_chosen_5d,
        AVG((outcome->'d1'->>'opportunity_cost')::double precision)
          FILTER (WHERE outcome->'d1'->>'opportunity_cost' IS NOT NULL) AS avg_opportunity_cost_1d,
        AVG((outcome->'d5'->>'opportunity_cost')::double precision)
          FILTER (WHERE outcome->'d5'->>'opportunity_cost' IS NOT NULL) AS avg_opportunity_cost_5d,
        AVG(CASE WHEN (outcome->'d1'->>'selected_best')::boolean THEN 1 ELSE 0 END)
          FILTER (WHERE outcome->'d1'->>'selected_best' IS NOT NULL) AS selected_best_rate_1d,
        AVG(CASE WHEN (outcome->'d5'->>'selected_best')::boolean THEN 1 ELSE 0 END)
          FILTER (WHERE outcome->'d5'->>'selected_best' IS NOT NULL) AS selected_best_rate_5d
      FROM multi_asset_decisions
      WHERE outcome IS NOT NULL
    `),
    db.query(`
      SELECT
        selected_lane AS lane,
        COUNT(*) FILTER (WHERE outcome->'d1'->>'chosen_return' IS NOT NULL)::int AS samples_1d,
        AVG((outcome->'d1'->>'chosen_return')::double precision)
          FILTER (WHERE outcome->'d1'->>'chosen_return' IS NOT NULL) AS avg_1d,
        COUNT(*) FILTER (WHERE outcome->'d5'->>'chosen_return' IS NOT NULL)::int AS samples_5d,
        AVG((outcome->'d5'->>'chosen_return')::double precision)
          FILTER (WHERE outcome->'d5'->>'chosen_return' IS NOT NULL) AS avg_5d,
        AVG((outcome->'d1'->>'opportunity_cost')::double precision)
          FILTER (WHERE outcome->'d1'->>'opportunity_cost' IS NOT NULL) AS opportunity_cost_1d,
        AVG((outcome->'d5'->>'opportunity_cost')::double precision)
          FILTER (WHERE outcome->'d5'->>'opportunity_cost' IS NOT NULL) AS opportunity_cost_5d
      FROM multi_asset_decisions
      WHERE outcome IS NOT NULL
      GROUP BY selected_lane
      ORDER BY samples_1d DESC, lane
    `),
    db.query(`
      SELECT decision_id, created_at, selected_lane, symbol, contract,
             confidence, outcome
      FROM multi_asset_decisions
      WHERE outcome IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 20
    `)
  ]);

  return {
    configured:true,
    summary:summary.rows[0]||{},
    by_lane:byLane.rows,
    recent:recent.rows
  };
}


export async function getAdaptiveResearchDataset(limit=600){
  if(!decisionMemoryConfigured()) return {configured:false};
  await ensureSchema();
  const db=pool();
  const safeLimit=Math.max(50,Math.min(2000,Number(limit)||600));

  const [router,scanner]=await Promise.all([
    db.query(`
      SELECT
        decision_id, created_at, origin, shadow, execution,
        selected_lane, symbol, contract, confidence, model,
        model_fallback_used, hard_risk_clear, hard_locks,
        lanes, outcome, meta
      FROM multi_asset_decisions
      WHERE outcome IS NOT NULL
        AND (outcome ? 'd1' OR outcome ? 'd5')
      ORDER BY created_at ASC
      LIMIT $1
    `,[safeLimit]),
    db.query(`
      SELECT
        dc.id, dc.created_at, dc.symbol, dc.scanner_score,
        dc.readiness_score, dc.readiness_grade, dc.selected,
        dc.event_risk, dc.outcome_1d, dc.outcome_3d, dc.outcome_5d,
        dc.candidate, dc.context,
        c.origin, c.decision_source, c.decision_action, c.stage,
        c.regime
      FROM decision_candidates dc
      JOIN decision_cycles c ON c.cycle_id=dc.cycle_id
      WHERE dc.outcome_1d IS NOT NULL
      ORDER BY dc.created_at ASC
      LIMIT $1
    `,[safeLimit])
  ]);

  return {
    configured:true,
    router:router.rows,
    scanner:scanner.rows
  };
}


function challengerSpecFromRecommendation(rec={}){
  if(rec?.status!=='SUPPORTED_FOR_FURTHER_TESTING') return null;

  if(rec.id==='router-selectivity'){
    return {
      parameter_type:'ROUTER_CONFIDENCE_FLOOR',
      config:{threshold:75},
      minimum_1d:20,
      minimum_5d:10
    };
  }
  if(rec.id==='router-confidence-floor' && Number.isFinite(Number(rec.proposed_threshold))){
    return {
      parameter_type:'ROUTER_CONFIDENCE_FLOOR',
      config:{threshold:Number(rec.proposed_threshold)},
      minimum_1d:20,
      minimum_5d:10
    };
  }
  if(rec.id==='long-scanner-threshold' && Number.isFinite(Number(rec.proposed_threshold))){
    return {
      parameter_type:'LONG_SCANNER_FLOOR',
      config:{threshold:Number(rec.proposed_threshold)},
      minimum_1d:20,
      minimum_5d:10
    };
  }
  if(String(rec.id||'').startsWith('lane-') && rec.lane){
    return {
      parameter_type:'BLOCK_SELECTED_LANE',
      config:{lane:String(rec.lane)},
      minimum_1d:16,
      minimum_5d:8
    };
  }
  return null;
}

function challengerExperimentId(rec,spec){
  const hash=crypto.createHash('sha1')
    .update(JSON.stringify({id:rec.id,type:spec.parameter_type,config:spec.config}))
    .digest('hex')
    .slice(0,10);
  return `${rec.id}-${hash}`;
}

export async function syncResearchChallengers(recommendations=[]){
  if(!decisionMemoryConfigured()) return {configured:false,created:0,active:0};
  await ensureSchema();
  const db=pool();
  let created=0;

  for(const rec of (Array.isArray(recommendations)?recommendations:[])){
    const spec=challengerSpecFromRecommendation(rec);
    if(!spec) continue;
    const experimentId=challengerExperimentId(rec,spec);

    const r=await db.query(`
      INSERT INTO research_challengers (
        experiment_id, source_recommendation_id, title,
        parameter_type, config, status, minimum_1d, minimum_5d,
        auto_apply, meta
      ) VALUES ($1,$2,$3,$4,$5::jsonb,'ACTIVE',$6,$7,FALSE,$8::jsonb)
      ON CONFLICT (experiment_id) DO UPDATE SET
        updated_at=NOW(),
        title=EXCLUDED.title,
        meta=EXCLUDED.meta
      RETURNING (xmax = 0) AS inserted
    `,[
      experimentId,
      String(rec.id||'unknown'),
      String(rec.title||rec.id||'Research challenger'),
      spec.parameter_type,
      json(spec.config),
      spec.minimum_1d,
      spec.minimum_5d,
      json({
        proposed_change:rec.proposed_change||null,
        rationale:rec.rationale||null,
        source_status:rec.status,
        source_sample:rec.current_sample??null
      })
    ]);
    if(r.rows?.[0]?.inserted===true) created++;
  }

  const active=await db.query(`
    SELECT COUNT(*)::int AS count
    FROM research_challengers
    WHERE status='ACTIVE'
  `);

  return {
    configured:true,
    created,
    active:Number(active.rows?.[0]?.count||0)
  };
}

export async function getActiveResearchChallengers(){
  if(!decisionMemoryConfigured()) return [];
  await ensureSchema();
  const db=pool();
  const r=await db.query(`
    SELECT experiment_id, source_recommendation_id, title,
           parameter_type, config, minimum_1d, minimum_5d, meta
    FROM research_challengers
    WHERE status='ACTIVE'
    ORDER BY created_at ASC
  `);
  return r.rows;
}

function applyResearchChallenger(experiment,decision={},lanes={}){
  const baselineAction=String(decision?.action||'SKIP');
  const confidence=Number(decision?.confidence);
  const type=String(experiment?.parameter_type||'');
  const config=experiment?.config&&typeof experiment.config==='object'?experiment.config:{};
  let challengerAction=baselineAction;
  let reason='No change on this decision.';

  if(type==='ROUTER_CONFIDENCE_FLOOR'){
    const threshold=Number(config.threshold);
    if(baselineAction!=='SKIP' && Number.isFinite(threshold) &&
       Number.isFinite(confidence) && confidence<threshold){
      challengerAction='SKIP';
      reason=`Router confidence ${confidence} is below challenger floor ${threshold}.`;
    }
  }else if(type==='LONG_SCANNER_FLOOR'){
    const threshold=Number(config.threshold);
    const score=Number(lanes?.LONG_EQUITY?.score);
    if(baselineAction==='LONG_EQUITY' && Number.isFinite(threshold) &&
       Number.isFinite(score) && score<threshold){
      challengerAction='SKIP';
      reason=`Long-equity scanner score ${score} is below challenger floor ${threshold}.`;
    }
  }else if(type==='BLOCK_SELECTED_LANE'){
    const lane=String(config.lane||'');
    if(lane && baselineAction===lane){
      challengerAction='SKIP';
      reason=`Challenger de-emphasizes selected lane ${lane}.`;
    }
  }

  const baselineLane=lanes?.[baselineAction]||null;
  const challengerLane=lanes?.[challengerAction]||null;

  return {
    affected:challengerAction!==baselineAction,
    baseline_action:baselineAction,
    challenger_action:challengerAction,
    baseline_symbol:baselineLane?.symbol||baselineLane?.underlying||decision?.symbol||null,
    challenger_symbol:challengerAction==='SKIP'?null:(challengerLane?.symbol||challengerLane?.underlying||decision?.symbol||null),
    baseline_contract:baselineLane?.contract||decision?.contract||null,
    challenger_contract:challengerAction==='SKIP'?null:(challengerLane?.contract||decision?.contract||null),
    confidence:Number.isFinite(confidence)?confidence:null,
    reason
  };
}

export async function recordResearchChallengerObservations({
  decision_id,
  decision={},
  lanes={},
  experiments=[]
}={}){
  if(!decisionMemoryConfigured()||!decision_id) return {configured:decisionMemoryConfigured(),recorded:0};
  await ensureSchema();
  const db=pool();
  let recorded=0;

  for(const experiment of (Array.isArray(experiments)?experiments:[])){
    const applied=applyResearchChallenger(experiment,decision,lanes);
    await db.query(`
      INSERT INTO research_challenger_observations (
        experiment_id, decision_id, affected,
        baseline_action, challenger_action,
        baseline_symbol, challenger_symbol,
        baseline_contract, challenger_contract,
        confidence, context
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT (experiment_id, decision_id) DO NOTHING
    `,[
      experiment.experiment_id,
      decision_id,
      Boolean(applied.affected),
      applied.baseline_action,
      applied.challenger_action,
      applied.baseline_symbol,
      applied.challenger_symbol,
      applied.baseline_contract,
      applied.challenger_contract,
      applied.confidence,
      json({
        reason:applied.reason,
        parameter_type:experiment.parameter_type,
        config:experiment.config,
        baseline_lane:lanes?.[applied.baseline_action]||null,
        challenger_lane:lanes?.[applied.challenger_action]||null
      })
    ]);
    recorded++;
  }
  return {configured:true,recorded};
}

function actionReturn(action,horizon){
  if(!horizon||typeof horizon!=='object') return null;
  if(action==='SKIP') return 0;
  const v=Number(horizon?.lane_returns?.[action]);
  return Number.isFinite(v)?v:null;
}

export async function updateResearchChallengerOutcomes(decisionId,outcome={}){
  if(!decisionMemoryConfigured()||!decisionId) return {updated:0};
  await ensureSchema();
  const db=pool();
  const obs=await db.query(`
    SELECT id, baseline_action, challenger_action
    FROM research_challenger_observations
    WHERE decision_id=$1
  `,[decisionId]);

  let updated=0;
  for(const row of obs.rows){
    const b1=actionReturn(row.baseline_action,outcome?.d1);
    const c1=actionReturn(row.challenger_action,outcome?.d1);
    const b5=actionReturn(row.baseline_action,outcome?.d5);
    const c5=actionReturn(row.challenger_action,outcome?.d5);

    await db.query(`
      UPDATE research_challenger_observations
      SET
        baseline_return_1d=COALESCE($2,baseline_return_1d),
        challenger_return_1d=COALESCE($3,challenger_return_1d),
        delta_1d=COALESCE($4,delta_1d),
        baseline_return_5d=COALESCE($5,baseline_return_5d),
        challenger_return_5d=COALESCE($6,challenger_return_5d),
        delta_5d=COALESCE($7,delta_5d)
      WHERE id=$1
    `,[
      row.id,
      b1,c1,(b1!=null&&c1!=null)?c1-b1:null,
      b5,c5,(b5!=null&&c5!=null)?c5-b5:null
    ]);
    updated++;
  }
  return {updated};
}

function pairedStats(rows,field,baselineField,challengerField){
  const vals=(rows||[]).filter(r=>Number.isFinite(Number(r?.[field])));
  const n=vals.length;
  if(!n){
    return {
      samples:0,baseline_avg:null,challenger_avg:null,
      avg_delta:null,challenger_win_rate:null,ci_low:null,ci_high:null
    };
  }
  const deltas=vals.map(r=>Number(r[field]));
  const mean=deltas.reduce((a,b)=>a+b,0)/n;
  const variance=n>1
    ?deltas.reduce((s,x)=>s+(x-mean)**2,0)/(n-1)
    :0;
  const sd=Math.sqrt(variance);
  const se=n>0?sd/Math.sqrt(n):0;
  const margin=1.96*se;
  const base=vals.map(r=>Number(r[baselineField])).filter(Number.isFinite);
  const chal=vals.map(r=>Number(r[challengerField])).filter(Number.isFinite);

  return {
    samples:n,
    baseline_avg:base.length?base.reduce((a,b)=>a+b,0)/base.length:null,
    challenger_avg:chal.length?chal.reduce((a,b)=>a+b,0)/chal.length:null,
    avg_delta:mean,
    challenger_win_rate:vals.filter(r=>Number(r[field])>0).length/n,
    ci_low:mean-margin,
    ci_high:mean+margin
  };
}

function challengerVerdict(exp,one,five){
  const min1=Number(exp.minimum_1d||20);
  const min5=Number(exp.minimum_5d||10);
  if(one.samples<min1||five.samples<min5) return 'RUNNING';
  if(one.ci_low>0&&five.ci_low>0) return 'PROMOTION_REVIEW_CANDIDATE';
  if(one.ci_high<0&&five.ci_high<0) return 'REJECT_RESEARCH';
  return 'INCONCLUSIVE';
}

export async function getResearchChallengerReport(){
  if(!decisionMemoryConfigured()) return {configured:false};
  await ensureSchema();
  const db=pool();

  const [experiments,observations]=await Promise.all([
    db.query(`
      SELECT experiment_id, created_at, updated_at,
             source_recommendation_id, title, parameter_type,
             config, status, minimum_1d, minimum_5d, auto_apply, meta
      FROM research_challengers
      ORDER BY created_at DESC
    `),
    db.query(`
      SELECT *
      FROM research_challenger_observations
      ORDER BY created_at ASC
    `)
  ]);

  const rows=experiments.rows.map(exp=>{
    const all=observations.rows.filter(o=>o.experiment_id===exp.experiment_id);
    const affected=all.filter(o=>o.affected===true);
    const one=pairedStats(affected,'delta_1d','baseline_return_1d','challenger_return_1d');
    const five=pairedStats(affected,'delta_5d','baseline_return_5d','challenger_return_5d');
    return {
      ...exp,
      observations:all.length,
      affected_decisions:affected.length,
      one_day:one,
      five_day:five,
      research_verdict:challengerVerdict(exp,one,five),
      auto_apply:false
    };
  });

  return {
    configured:true,
    generated_at:new Date().toISOString(),
    auto_apply:false,
    promotion_policy:'Manual review only. No challenger can modify production settings automatically.',
    experiments:rows
  };
}
