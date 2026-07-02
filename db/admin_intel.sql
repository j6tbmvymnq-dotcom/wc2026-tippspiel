-- Mini-Admin: read-only intel for early/fair evaluation of the prediction game.
--
-- 1) Adds app_settings.admin_nicknames (comma-separated list of nicknames).
--    Example: update app_settings set admin_nicknames = 'Alice, Bob' where id = 1;
-- 2) Adds get_admin_intel(p_secret): SECURITY DEFINER RPC that
--    - authenticates the caller via login_operative (their normal passphrase),
--    - checks their nickname (case-insensitive) against admin_nicknames,
--    - returns a read-only JSON snapshot: full leaderboard incl. tie-breaks,
--      ALL bonus predictions per player, and all predictions for matches that
--      are not finished yet (the open ones relevant for an early evaluation).
--    Non-admins (and wrong secrets) simply get NULL — the app shows nothing.
--
-- The function only reads; admins keep playing normally and cannot change anything.
--
-- Run this once in the Supabase SQL editor.

alter table app_settings add column if not exists admin_nicknames text default '';

create or replace function get_admin_intel(p_secret text)
returns json
language plpgsql
security definer
as $$
declare
    v_player record;
    v_admins text;
    result json;
begin
    select * into v_player from login_operative(p_secret) limit 1;
    if not found then
        return null;
    end if;

    select admin_nicknames into v_admins from app_settings where id = 1;
    if v_admins is null or btrim(v_admins) = '' then
        return null;
    end if;

    if not exists (
        select 1
        from unnest(string_to_array(v_admins, ',')) a(name)
        where lower(btrim(a.name)) = lower(v_player.nickname)
    ) then
        return null;
    end if;

    select json_build_object(
        'generated_at', now(),
        'players', (
            select coalesce(json_agg(row_to_json(p)), '[]'::json)
            from (
                select id, nickname, score,
                       coalesce(exact_hits, 0) as exact_hits,
                       coalesce(bonus_hits, 0) as bonus_hits
                from public_leaderboard
                order by score desc, exact_hits desc nulls last, bonus_hits desc nulls last
            ) p
        ),
        'bonus', (
            select coalesce(json_agg(row_to_json(b)), '[]'::json)
            from (
                select player_id, question_id, answer,
                       coalesce(points_earned, 0) as points_earned,
                       coalesce(evaluated, false) as evaluated
                from bonus_predictions
            ) b
        ),
        'open_predictions', (
            select coalesce(json_agg(row_to_json(op)), '[]'::json)
            from (
                select pr.player_id, pr.match_id, pr.home_pred, pr.away_pred,
                       m.home_team, m.away_team, m.kickoff, m.stage
                from predictions pr
                join matches m on m.id = pr.match_id
                where m.status <> 'FINISHED'
                order by m.kickoff
            ) op
        )
    ) into result;

    return result;
end;
$$;

grant execute on function get_admin_intel(text) to anon;
