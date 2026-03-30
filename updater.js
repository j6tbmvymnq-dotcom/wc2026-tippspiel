import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const footballApiKey = process.env.FOOTBALL_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

// Die URL der Fußball-API (WM 2026 = Competition Code 'WC')
const API_URL = 'https://api.football-data.org/v4/competitions/WC/matches';

async function runUpdate() {
    console.log("Starte WM-Update-Job...");

    try {
        // 1. Echte Ergebnisse und Spielpläne von der API holen
        const response = await fetch(API_URL, {
            headers: { 'X-Auth-Token': footballApiKey }
        });
        
        if (!response.ok) throw new Error(`API Fehler: ${response.status} - Bitte API-Key prüfen.`);
        const data = await response.json();
        
        console.log(`Verarbeite ${data.matches.length} Spiele aus der API...`);

        // 2. Jedes Spiel durchgehen und in die Datenbank eintragen (Upsert)
        for (const match of data.matches) {
            const matchId = match.id;
            
            // Wenn Teams noch nicht feststehen (z.B. späteres KO-Spiel), nehmen wir 'TBD'
            const homeTeam = match.homeTeam?.name || 'TBD';
            const awayTeam = match.awayTeam?.name || 'TBD';
            
            // Tore (können null sein, wenn das Spiel noch nicht lief)
            const homeScore = match.score?.fullTime?.home ?? null;
            const awayScore = match.score?.fullTime?.away ?? null;

            // Spiel in unserer DB eintragen oder aktualisieren
            const { error: matchError } = await supabase.from('matches').upsert({
                id: matchId,
                home_team: homeTeam,
                away_team: awayTeam,
                kickoff: match.utcDate,
                status: match.status,
                home_score: homeScore,
                away_score: awayScore
            });

            if (matchError) {
                console.error(`Fehler beim Speichern von Spiel ${matchId}:`, matchError);
                continue;
            }

            // 3. Punkteauswertung: NUR WENN DAS SPIEL BEENDET IST
            if (match.status === 'FINISHED' && homeScore !== null && awayScore !== null) {
                
                // Alle Tipps für dieses Spiel aus der DB holen, die noch keine Punkte haben
                const { data: predictions } = await supabase
                    .from('predictions')
                    .select('*')
                    .eq('match_id', matchId)
                    .eq('points_earned', 0); 

                if (!predictions || predictions.length === 0) continue;

                console.log(`Werte ${predictions.length} neue Tipps für beendetes Spiel ${homeTeam} vs ${awayTeam} aus...`);

                for (const pred of predictions) {
                    let points = 0;
                    
                    const isExact = (pred.home_pred === homeScore && pred.away_pred === awayScore);
                    const predDiff = pred.home_pred - pred.away_pred;
                    const actualDiff = homeScore - awayScore;
                    const isTendency = (Math.sign(predDiff) === Math.sign(actualDiff));

                    if (isExact) {
                        points = 3;
                    } else if (isTendency) {
                        points = 1;
                    }

                    if (points > 0) {
                        await supabase.from('predictions').update({ points_earned: points }).eq('id', pred.id);
                        
                        const { data: player } = await supabase.from('players').select('score').eq('id', pred.player_id).single();
                        await supabase.from('players').update({ score: player.score + points }).eq('id', pred.player_id);
                    }
                }
            }
        }
        
        console.log("Update-Job erfolgreich abgeschlossen! Spielpläne sind synchronisiert.");

    } catch (error) {
        console.error("Fehler beim Update-Job:", error);
    }
}

runUpdate();
