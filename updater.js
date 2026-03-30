import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const footballApiKey = process.env.FOOTBALL_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

// Die URLs der Fußball-API (WM 2026)
const MATCHES_URL = 'https://api.football-data.org/v4/competitions/WC/matches';
const STANDINGS_URL = 'https://api.football-data.org/v4/competitions/WC/standings';

async function runUpdate() {
    console.log("Starte WM-Update-Job...");

    try {
        // ==========================================
        // TEIL 1: SPIELE & PUNKTE AKTUALISIEREN
        // ==========================================
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
            
            // NEU: Das Stadion aus der API auslesen (falls noch nicht bekannt, 'TBD' setzen)
            const venueName = match.venue || 'TBD';

            const { error: matchError } = await supabase.from('matches').upsert({
                id: matchId,
                home_team: homeTeam,
                away_team: awayTeam,
                kickoff: match.utcDate,
                status: match.status,
                home_score: homeScore,
                away_score: awayScore,
                venue: venueName // NEU: Das Stadion in die Datenbank schreiben
            });


            if (matchError) console.error(`Fehler bei Spiel ${matchId}:`, matchError);

            if (match.status === 'FINISHED' && homeScore !== null && awayScore !== null) {
                const { data: predictions } = await supabase
                    .from('predictions')
                    .select('*')
                    .eq('match_id', matchId)
                    .eq('points_earned', 0); 

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

        // ==========================================
        // TEIL 2: GRUPPENTABELLEN AKTUALISIEREN
        // ==========================================
        console.log("Hole Tabellenstände von der API...");
        const standingsResponse = await fetch(STANDINGS_URL, { headers: { 'X-Auth-Token': footballApiKey } });
        
        if (standingsResponse.ok) {
            const standingsData = await standingsResponse.json();
            const standingsToUpsert = [];

            const groupStandings = standingsData.standings.filter(s => s.type === 'TOTAL');

            for (const group of groupStandings) {
                const groupId = group.group ? group.group.replace('GROUP_', '') : 'TBD';

                for (const teamRow of group.table) {
                    
                    // FIX: Sichere Abfrage für Teams, die noch "null" sind
                    const safeTeamId = teamRow.team?.id ? teamRow.team.id.toString() : `TBD_${groupId}_${teamRow.position}`;
                    const safeTeamName = teamRow.team?.name || `Team ${groupId}${teamRow.position}`;

                    standingsToUpsert.push({
                        team_id: safeTeamId,
                        team_name: safeTeamName,
                        group_id: groupId,
                        played: teamRow.playedGames || 0,
                        won: teamRow.won || 0,
                        drawn: teamRow.draw || 0,
                        lost: teamRow.lost || 0,
                        goals_for: teamRow.goalsFor || 0,
                        goals_against: teamRow.goalsAgainst || 0,
                        points: teamRow.points || 0
                    });
                }
            }

            if (standingsToUpsert.length > 0) {
                console.log(`Schreibe ${standingsToUpsert.length} Teams in die Datenbank...`);
                const { error: standingsError } = await supabase.from('group_standings').upsert(standingsToUpsert);
                if (standingsError) console.error("Fehler beim Speichern der Tabellen:", standingsError);
            }
        } else {
            console.warn(`Fehler beim Abruf der Tabellen. API Status: ${standingsResponse.status}`);
        }

        console.log("Update-Job komplett und erfolgreich abgeschlossen!");

    } catch (error) {
        console.error("Schwerer Fehler beim Update-Job:", error);
    }
}

// ... dein bisheriger Code von runUpdate() bleibt unangetastet ...

// Hilfsfunktion: Lässt das Skript für X Millisekunden pausieren
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startLoop() {
    const cycles = 4; // Wie oft soll das Skript innerhalb der Action laufen?
    const waitTime = 60 * 1000; // 60 Sekunden in Millisekunden

    for (let i = 1; i <= cycles; i++) {
        console.log(`\n=== Starte Durchlauf ${i} von ${cycles} ===`);
        
        await runUpdate(); // Führt dein normales Update aus

        // Wenn es nicht der letzte Durchlauf ist, warte 1 Minute
        if (i < cycles) {
            console.log(`Warte 60 Sekunden bis zum nächsten Abruf...`);
            await delay(waitTime);
        }
    }
    console.log("\n✅ Alle Durchläufe für diese Action-Runde beendet.");
}

// Startet die Schleife
startLoop();

