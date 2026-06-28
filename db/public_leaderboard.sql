-- public_leaderboard view with tie-break columns
--
-- Tie-break rules (applied in the frontend after fetching this view):
--   1. score            (desc)  -- total points
--   2. exact_hits       (desc)  -- number of exact-score predictions (points_earned = 3)
--   3. bonus_hits       (desc)  -- number of correct bonus answers   (points_earned > 0)
--
-- Computed live from predictions / bonus_predictions, so the values always stay
-- in sync with the scoring done by updater.js — no extra maintenance, no drift.
--
-- Run this in the Supabase SQL editor. `create or replace` keeps existing grants,
-- so the anon role can still read the view.
--
-- NOTE: if your current public_leaderboard has extra filtering (e.g. hiding test
-- accounts), merge that WHERE clause into the query below before running.

create or replace view public_leaderboard as
select
    p.id,
    p.nickname,
    p.score,
    coalesce(e.exact_hits, 0) as exact_hits,
    coalesce(b.bonus_hits, 0) as bonus_hits
from players p
left join (
    select player_id, count(*)::int as exact_hits
    from predictions
    where points_earned = 3
    group by player_id
) e on e.player_id = p.id
left join (
    select player_id, count(*)::int as bonus_hits
    from bonus_predictions
    where points_earned > 0
    group by player_id
) b on b.player_id = p.id;

-- Optional, helps the aggregation at ~350 players (safe to skip / run once):
-- create index if not exists idx_predictions_player_points on predictions (player_id, points_earned);
-- create index if not exists idx_bonus_predictions_player_points on bonus_predictions (player_id, points_earned);
