import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const footballApiKey = process.env.FOOTBALL_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

const MATCHES_URL = 'https://api.football-data.org/v4/competitions/WC/matches';
const STANDINGS_URL = 'https://api.football-data.org/v4/competitions/WC/standings';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runUpdate() {
    console.log("Starte WM-Update-Job...");
    try {
        console.log("Hole Spiele von der API...");
        const matchesResponse = await fetch(MATCHES_URL, { headers: { 'X-Auth-Token': footballApiKey } });
        if (!matchesResponse.ok) throw new Error(`API Fehler (Matches): ${matchesResponse.status}`);
        const matchesData = await matchesResponse.json();
        
        for (const match of matchesData.matches) {
            const matchId = match.id;
            const homeTeam = match.homeTeam?.name || 'TBD';
            const awayTeam = match.awayTeam?.name || 'TBD';
            const homeScore = match.score?.fullTime?.home ?? null;
            const awayScore = match.score?.fullTime?.away ?? null;
            const venueName = match.venue || 'TBD'; // Die API wird das bald füllen
            
            // NEU: Flaggen-URLs auslesen
            const homeLogo = match.homeTeam?.crest || '';
            const awayLogo = match.awayTeam?.crest || '';

            const { error: matchError } = await supabase.from('matches').upsert({
                id: matchId,
                home_team: homeTeam,
                away_team: awayTeam,
                kickoff: match.utcDate,
                status: match.status,
                home_score: homeScore,
                away_score: awayScore,
                venue: venueName,
                home_logo: homeLogo,
                away_logo: awayLogo
            });

            if (matchError) console.error(`Fehler bei Spiel ${matchId}:`, matchError);

            if (match.status === 'FINISHED' && homeScore !== null && awayScore !== null) {
                const { data: predictions } = await supabase.from('predictions').select('*').eq('match_id', matchId).eq('points_earned', 0); 
                if (!predictions || predictions.length === 0) continue;

                for (const pred of predictions) {
                    let points = 0;
                    const isExact = (pred.home_pred === homeScore && pred.away_pred === awayScore);
                    const isTendency = (Math.sign(pred.home_pred - pred.away_pred) === Math.sign(homeScore - awayScore));

                    if (isExact) points = 3;
                    else if (isTendency) points = 1;

                    if (points > 0) {
                        await supabase.from('predictions').update({ points_earned: points }).eq('id', pred.id);
                        const { data: player } = await supabase.from('players').select('score').eq('id', pred.player_id).single();
                        await supabase.from('players').update({ score: player.score + points }).eq('id', pred.player_id);
                    }
                }
            }
        }
        console.log("Spiele erfolgreich synchronisiert.");

        console.log("Hole Tabellenstände von der API...");
        const standingsResponse = await fetch(STANDINGS_URL, { headers: { 'X-Auth-Token': footballApiKey } });
        
        if (standingsResponse.ok) {
            const standingsData = await standingsResponse.json();
            const standingsToUpsert = [];
            const groupStandings = standingsData.standings.filter(s => s.type === 'TOTAL');

            for (const group of groupStandings) {
                const groupId = group.group ? group.group.replace('GROUP_', '') : 'TBD';
                for (const teamRow of group.table) {
                    standingsToUpsert.push({
                        team_id: teamRow.team.id.toString(),
                        team_name: teamRow.team.name,
                        group_id: groupId,
                        played: teamRow.playedGames,
                        won: teamRow.won,
                        drawn: teamRow.draw,
                        lost: teamRow.lost,
                        goals_for: teamRow.goalsFor,
                        goals_against: teamRow.goalsAgainst,
                        points: teamRow.points,
                        crest: teamRow.team.crest || '' // NEU: Flagge für die Tabelle
                    });
                }
            }
            if (standingsToUpsert.length > 0) {
                await supabase.from('group_standings').upsert(standingsToUpsert);
            }
        }
    } catch (error) {
        console.error("Schwerer Fehler beim Update-Job:", error);
    }
}

async function startLoop() {
    const cycles = 3;
    const waitTime = 60 * 1000;
    for (let i = 1; i <= cycles; i++) {
        await runUpdate();
        if (i < cycles) await delay(waitTime);
    }
}

startLoop();
