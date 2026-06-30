-- recompute_player_scores()
--
-- Recomputes every player's score as the sum of their earned match points
-- (predictions.points_earned) plus their earned bonus points
-- (bonus_predictions.points_earned). This makes players.score a pure derivative of
-- the source tables: crash-safe and idempotent. The wm-update edge function calls
-- this (via supabase.rpc) once per run, but only when new points were awarded.
--
-- Run this once in the Supabase SQL editor. The edge function uses the service role,
-- which may execute it.

create or replace function recompute_player_scores()
returns void
language sql
as $$
    update players p
    set score = coalesce(agg.total, 0)
    from (
        select pl.id,
               coalesce(pr.s, 0) + coalesce(bo.s, 0) as total
        from players pl
        left join (
            select player_id, sum(points_earned) as s
            from predictions group by player_id
        ) pr on pr.player_id = pl.id
        left join (
            select player_id, sum(points_earned) as s
            from bonus_predictions group by player_id
        ) bo on bo.player_id = pl.id
    ) agg
    where p.id = agg.id;
$$;

-- Optional: run once manually to reconcile any historical drift right after creating it.
-- select recompute_player_scores();

-- Helps the aggregation at ~350 players (safe to skip / run once):
-- create index if not exists idx_predictions_player on predictions (player_id);
-- create index if not exists idx_bonus_predictions_player on bonus_predictions (player_id);
