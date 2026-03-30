import { createClient } from '@supabase/supabase-js';

// Sicheres Laden der geheimen Variablen aus GitHub Secrets
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const footballApiKey = process.env.FOOTBALL_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

// Die URL der Fußball-API (Beispiel für football-data.org / WM 2026)
const API_URL = 'https://api.football-data.org/v4/competitions/WC/matches';

async function runUpdate() {
    console.log("Starte WM-Update-Job...");

    try {
        // 1. Echte Ergebnisse von der API holen
        const response = await fetch(API_URL, {
            headers: { 'X-Auth-Token': footballApiKey }
        });
        
        if (!response.ok) throw new Error(`API Fehler: ${response.status}`);
        const data = await response.json();
        
        // Wir filtern nach Spielen, die beendet sind ('FINISHED')
        const finishedMatches = data.matches.filter(m => m.status === 'FINISHED');
        console.log(`${finishedMatches.length} beendete Spiele gefunden.`);

        // 2. Supabase Matches aktualisieren und Punkte berechnen
        for (const match of finishedMatches) {
            const matchId = match.id;
            const homeScore = match.score.fullTime.home;
            const awayScore = match.score.fullTime.away;

            // Spiel in unserer DB auf 'FINISHED' setzen und Tore eintragen
            await supabase.from('matches').update({
                status: 'FINISHED',
                home_score: homeScore,
                away_score: awayScore
            }).eq('id', matchId);

            // 3. Alle Tipps für dieses Spiel aus der DB holen
            const { data: predictions } = await supabase
                .from('predictions')
                .select('*')
                .eq('match_id', matchId)
                // Nur Tipps auswerten, die noch keine Punkte berechnet bekommen haben
                .eq('points_earned', 0); 

            if (!predictions || predictions.length === 0) continue;

            console.log(`Werte ${predictions.length} Tipps für Spiel ${matchId} aus...`);

            // 4. Punkte-Logik anwenden (3 Punkte für exakt, 1 für Tendenz)
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
                    // Trage die verdienten Punkte für diesen Tipp ein
                    await supabase.from('predictions').update({ points_earned: points }).eq('id', pred.id);
                    
                    // Addiere die Punkte zum Gesamt-Score des Spielers
                    const { data: player } = await supabase.from('players').select('score').eq('id', pred.player_id).single();
                    await supabase.from('players').update({ score: player.score + points }).eq('id', pred.player_id);
                }
            }
        }
        console.log("Update-Job erfolgreich abgeschlossen!");

    } catch (error) {
        console.error("Fehler beim Update-Job:", error);
    }
}

runUpdate();
