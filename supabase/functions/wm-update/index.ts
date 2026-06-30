import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SERVICE_ROLE_KEY')!;
const footballApiKey = Deno.env.get('FOOTBALL_API_KEY')!;

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
    db: { schema: 'public' }
});

const MATCHES_URL = 'https://api.football-data.org/v4/competitions/WC/matches';
const STANDINGS_URL = 'https://api.football-data.org/v4/competitions/WC/standings';

// football-data v4 lässt die Live-Felder `minute` und `injuryTime` standardmäßig weg.
// Sie werden nur geliefert, wenn man explizit die API-Version v4.1 anfordert (laut
// football-data-Support; ändert sonst nichts an den stabilen Feldern).
const API_HEADERS = {
    'X-Auth-Token': footballApiKey,
    'X-Api-Version': 'v4.1'
};

// --- HELPER: BONUS PUNKTE VERTEILEN ---
async function distributeBonusPoints(qId: string, correctAnswer: string, pointsToAward: number) {
    const { data: correctPredictions, error } = await supabase
        .from('bonus_predictions')
        .select('*')
        .eq('question_id', qId)
        .eq('answer', correctAnswer)
        .eq('evaluated', false);

    if (error) {
        console.error(`Fehler BQ ${qId}:`, error);
        return;
    }
    if (!correctPredictions || correctPredictions.length === 0) return;

    console.log(`[BONUS] ${pointsToAward} Punkte für ${qId} (${correctAnswer}) an ${correctPredictions.length} Spieler.`);

    for (const pred of correctPredictions) {
        await supabase
            .from('bonus_predictions')
            .update({ points_earned: pointsToAward, evaluated: true })
            .eq('id', pred.id);

        const { data: player } = await supabase
            .from('players')
            .select('score')
            .eq('id', pred.player_id)
            .single();

        if (!player) {
            console.error(`Spieler ${pred.player_id} nicht gefunden, überspringe.`);
            continue;
        }

        await supabase
            .from('players')
            .update({ score: player.score + pointsToAward })
            .eq('id', pred.player_id);
    }
}

// --- HELPER: 90-Minuten-Ergebnis eines Spiels (regularTime, sonst fullTime) ---
// Konsistent zur Spielwertung: nur die reguläre Spielzeit zählt, Verlängerung/Elfmeter
// werden ignoriert.
function score90(m: any): { home: number | null; away: number | null } {
    const ft = m.score?.fullTime ?? {};
    const rt = m.score?.regularTime ?? {};
    return { home: rt.home ?? ft.home ?? null, away: rt.away ?? ft.away ?? null };
}

// --- MAIN UPDATE JOB ---
async function runUpdate() {
    console.log("Starte WM-Update-Job...");

    // ==========================================
    // TEIL 1: SPIELE AKTUALISIEREN & PUNKTE BERECHNEN
    // ==========================================
    const matchesResponse = await fetch(MATCHES_URL, {
        headers: API_HEADERS
    });
    if (!matchesResponse.ok) throw new Error(`API Fehler (Matches): ${matchesResponse.status}`);

    const matchesData = await matchesResponse.json();
    const allMatches = matchesData.matches;


    for (const match of allMatches) {
        const matchId = match.id;

        // --- SCORES ---
        // WICHTIG: Das Tippspiel zählt nur die reguläre Spielzeit (90' + Nachspielzeit).
        // Bei football-data v4 steht das 90-Minuten-Ergebnis in `regularTime`, während
        // `fullTime` das Endergebnis INKLUSIVE Verlängerung enthält. Bei Spielen ohne
        // Verlängerung fehlt `regularTime`, dann IST `fullTime` bereits das 90'-Ergebnis.
        const ft = match.score?.fullTime ?? {};
        const rt = match.score?.regularTime ?? {};
        const pen = match.score?.penalties ?? {};

        const ftHome = ft.home ?? null;
        const ftAway = ft.away ?? null;
        const rtHome = rt.home ?? null;
        const rtAway = rt.away ?? null;

        // 90-Minuten-Ergebnis (Basis für Wertung UND Anzeige als "(90')").
        const homeScore = rtHome ?? ftHome;
        const awayScore = rtAway ?? ftAway;

        // Verlängerungstore als Delta auf das 90'-Ergebnis (final − 90'),
        // damit die App "(90' x:y)" plus den Endstand korrekt anzeigen kann.
        const wentToOvertime = rtHome !== null && rtAway !== null && ftHome !== null && ftAway !== null;
        const homeScoreET = wentToOvertime ? (ftHome - rtHome) : null;
        const awayScoreET = wentToOvertime ? (ftAway - rtAway) : null;

        const homeScorePen = pen.home ?? null;
        const awayScorePen = pen.away ?? null;

        // `minute`/`injuryTime` kommen jetzt über den v4.1-Header (siehe API_HEADERS).
        // Der Log bestätigt bei Live-Spielen im Supabase-Function-Log, dass Werte ankommen.
        if (match.status === 'IN_PLAY' || match.status === 'PAUSED') {
            console.log(`[LIVE] ${match.homeTeam?.name} vs ${match.awayTeam?.name} | status=${match.status} | minute=${JSON.stringify(match.minute)} | injuryTime=${JSON.stringify(match.injuryTime)}`);
        }

        const upsertObj: any = {
            id: matchId,
            home_team: match.homeTeam?.name || 'TBD',
            away_team: match.awayTeam?.name || 'TBD',
            kickoff: match.utcDate,
            status: match.status,
            minute: match.minute ?? null,
            venue: match.venue || 'TBD',
            home_logo: match.homeTeam?.crest || '',
            away_logo: match.awayTeam?.crest || '',
            stage: match.stage || 'TBD',
            match_group: match.group ? match.group.replace('GROUP_', '') : 'TBD'
        };

        // Ergebnis nur schreiben wenn die API echte Werte liefert (nie mit null überschreiben)
        if (homeScore !== null && awayScore !== null) {
            upsertObj.home_score = homeScore;
            upsertObj.away_score = awayScore;
        }
        if (homeScoreET !== null && awayScoreET !== null) {
            upsertObj.home_score_et = homeScoreET;
            upsertObj.away_score_et = awayScoreET;
        }
        if (homeScorePen !== null && awayScorePen !== null) {
            upsertObj.home_score_pen = homeScorePen;
            upsertObj.away_score_pen = awayScorePen;
        }

        const { error: matchError } = await supabase.from('matches').upsert(upsertObj);

        if (matchError) console.error(`Fehler bei Spiel ${matchId}:`, matchError);

        // Punkte werden gegen das 90-Minuten-Ergebnis (homeScore/awayScore) gewertet.
        if (match.status === 'FINISHED' && homeScore !== null && awayScore !== null) {
            const { data: predictions } = await supabase
                .from('predictions')
                .select('*')
                .eq('match_id', matchId)
                .eq('evaluated', false);

            if (!predictions || predictions.length === 0) continue;

            for (const pred of predictions) {
                let points = 0;
                const isExact = pred.home_pred === homeScore && pred.away_pred === awayScore;
                const isTendency = Math.sign(pred.home_pred - pred.away_pred) === Math.sign(homeScore - awayScore);

                if (isExact) points = 3;
                else if (isTendency) points = 1;

                await supabase
                    .from('predictions')
                    .update({ points_earned: points, evaluated: true })
                    .eq('id', pred.id);

                if (points > 0) {
                    const { data: player } = await supabase
                        .from('players')
                        .select('score')
                        .eq('id', pred.player_id)
                        .single();

                    if (!player) {
                        console.error(`Spieler ${pred.player_id} nicht gefunden, überspringe.`);
                        continue;
                    }

                    await supabase
                        .from('players')
                        .update({ score: player.score + points })
                        .eq('id', pred.player_id);
                }
            }
        }
    }
    console.log("Spiele erfolgreich synchronisiert.");

    // ==========================================
    // TEIL 2: GRUPPENTABELLEN AKTUALISIEREN
    // ==========================================
    const standingsResponse = await fetch(STANDINGS_URL, {
        headers: API_HEADERS
    });
    let currentStandings: any[] = [];

    if (standingsResponse.ok) {
        const standingsData = await standingsResponse.json();
        const standingsToUpsert: any[] = [];
        const groupStandings = standingsData.standings.filter((s: any) => s.type === 'TOTAL');

        for (const group of groupStandings) {
            const groupId = group.group ? group.group.replace('GROUP_', '') : 'TBD';
            let teamIndex = 1;

            for (const teamRow of group.table) {
                const standingObj = {
                    team_id: teamRow.team?.id ? teamRow.team.id.toString() : `TBD_${groupId}_${teamIndex}`,
                    team_name: teamRow.team?.name || `TBD (Group ${groupId})`,
                    group_id: groupId,
                    played: teamRow.playedGames || 0,
                    won: teamRow.won || 0,
                    drawn: teamRow.draw || 0,
                    lost: teamRow.lost || 0,
                    goals_for: teamRow.goalsFor || 0,
                    goals_against: teamRow.goalsAgainst || 0,
                    points: teamRow.points || 0,
                    crest: teamRow.team?.crest || ''
                };
                standingsToUpsert.push(standingObj);
                currentStandings.push(standingObj);
                teamIndex++;
            }
        }

        if (standingsToUpsert.length > 0) {
            await supabase.from('group_standings').upsert(standingsToUpsert);
        }
    }

    // ==========================================
    // TEIL 3: AUTOMATISCHE BONUS-AUSWERTUNG
    // ==========================================
    console.log("Prüfe Bonus-Auswertungen...");

    const groupMatches = allMatches.filter((m: any) => m.stage === 'GROUP_STAGE');
    const r32Matches = allMatches.filter((m: any) => m.stage === 'LAST_32');
    const finalMatch = allMatches.find((m: any) => m.stage === 'FINAL');

    const groupsFinished = groupMatches.length > 0 && groupMatches.every((m: any) => m.status === 'FINISHED');
    const r32Finished = r32Matches.length > 0 && r32Matches.every((m: any) => m.status === 'FINISHED');
    const tournamentFinished = finalMatch && finalMatch.status === 'FINISHED';

    if (groupsFinished && currentStandings.length > 0) {
        console.log("-> Gruppenphase beendet. Analysiere BQ 2 und BQ 4...");

        const groupDiffs: Record<string, number> = {};
        const groups = [...new Set(currentStandings.map((s: any) => s.group_id))];

        groups.forEach((g: any) => {
            const groupTeams = currentStandings
                .filter((s: any) => s.group_id === g)
                .sort((a: any, b: any) => b.points - a.points);
            if (groupTeams.length >= 3) {
                groupDiffs[`GROUP ${g}`] = groupTeams[0].points - groupTeams[2].points;
            }
        });

        if (Object.keys(groupDiffs).length > 0) {
            const minDiff = Math.min(...Object.values(groupDiffs));
            for (const gName of Object.keys(groupDiffs).filter(g => groupDiffs[g] === minDiff)) {
                await distributeBonusPoints('bq4', gName, 2);
            }
        }

        const TOP_20 = ["SPAIN","FRANCE","ARGENTINA","ENGLAND","PORTUGAL","NETHERLANDS","BRAZIL","MOROCCO","BELGIUM","GERMANY","CROATIA","COLOMBIA","SENEGAL","MEXICO","UNITED STATES","URUGUAY","JAPAN","SWITZERLAND"];
        const advancedTeamNames = new Set(
            r32Matches.flatMap((m: any) => [
                m.homeTeam?.name?.toUpperCase(),
                m.awayTeam?.name?.toUpperCase()
            ]).filter(Boolean)
        );

        for (const nation of TOP_20) {
            const teamInStandings = currentStandings.find((s: any) => s.team_name.toUpperCase() === nation);
            if (teamInStandings && !advancedTeamNames.has(nation)) {
                await distributeBonusPoints('bq2', nation, 2);
            }
        }
    }

    if (r32Finished && currentStandings.length > 0) {
        console.log("-> Runde der 32 beendet. Prüfe BQ 6...");

        const groups = [...new Set(currentStandings.map((s: any) => s.group_id))];
        const groupWinners: string[] = [];
        groups.forEach((g: any) => {
            const groupTeams = currentStandings
                .filter((s: any) => s.group_id === g)
                .sort((a: any, b: any) => b.points - a.points);
            if (groupTeams.length > 0) groupWinners.push(groupTeams[0].team_name.toUpperCase());
        });

        let eliminatedWinnersCount = 0;
        r32Matches.forEach((m: any) => {
            const home = m.homeTeam?.name?.toUpperCase();
            const away = m.awayTeam?.name?.toUpperCase();
            const apiWinner = m.score?.winner;
            let loserTeam = null;
            if (apiWinner === 'HOME_TEAM') loserTeam = away;
            else if (apiWinner === 'AWAY_TEAM') loserTeam = home;
            if (loserTeam && groupWinners.includes(loserTeam)) eliminatedWinnersCount++;
        });

        await distributeBonusPoints('bq6', eliminatedWinnersCount.toString(), 5);
    }

    if (tournamentFinished) {
        console.log("-> Turnier beendet. Finale Auswertung BQ 1, 3 und 5...");

        let wcWinner = null;
        if (finalMatch.score?.winner === 'HOME_TEAM') wcWinner = finalMatch.homeTeam?.name?.toUpperCase();
        else if (finalMatch.score?.winner === 'AWAY_TEAM') wcWinner = finalMatch.awayTeam?.name?.toUpperCase();
        if (wcWinner) await distributeBonusPoints('bq1', wcWinner, 10);

        // BQ 5: 0:0-Spiele nach regulärer Spielzeit (90'), Verlängerung ignoriert.
        const cleanSheets = allMatches.filter((m: any) => {
            if (m.status !== 'FINISHED') return false;
            const s = score90(m);
            return s.home === 0 && s.away === 0;
        }).length;
        await distributeBonusPoints('bq5', cleanSheets.toString(), 5);

        // BQ 3: höchste Tordifferenz nach regulärer Spielzeit (90'), Verlängerung ignoriert.
        let maxDiff = 0;
        let dominantNations: string[] = [];
        allMatches.forEach((m: any) => {
            if (m.status === 'FINISHED') {
                const s = score90(m);
                const hGoals = s.home ?? 0;
                const aGoals = s.away ?? 0;
                const diff = Math.abs(hGoals - aGoals);
                if (diff > maxDiff) {
                    maxDiff = diff;
                    dominantNations = [hGoals > aGoals ? m.homeTeam.name.toUpperCase() : m.awayTeam.name.toUpperCase()];
                } else if (diff === maxDiff && diff > 0) {
                    dominantNations.push(hGoals > aGoals ? m.homeTeam.name.toUpperCase() : m.awayTeam.name.toUpperCase());
                }
            }
        });

        for (const nation of [...new Set(dominantNations)]) {
            await distributeBonusPoints('bq3', nation as string, 2);
        }
    }

    console.log("Update-Job abgeschlossen!");
}

// --- EDGE FUNCTION HANDLER ---
Deno.serve(async (_req) => {
    try {
        await runUpdate();
        return new Response(
            JSON.stringify({ success: true, timestamp: new Date().toISOString() }),
            { headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error("Schwerer Fehler:", error);
        return new Response(
            JSON.stringify({ success: false, error: String(error) }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
});
