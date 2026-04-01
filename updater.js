import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const footballApiKey = process.env.FOOTBALL_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

const MATCHES_URL = 'https://api.football-data.org/v4/competitions/WC/matches';
const STANDINGS_URL = 'https://api.football-data.org/v4/competitions/WC/standings';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- HELPER: BONUS PUNKTE VERTEILEN ---
async function distributeBonusPoints(qId, correctAnswer, pointsToAward) {
    // Finde alle richtigen Antworten, die noch keine Punkte bekommen haben
    const { data: correctPredictions, error } = await supabase
        .from('bonus_predictions')
        .select('*')
        .eq('question_id', qId)
        .eq('answer', correctAnswer)
        .eq('points_earned', 0);

    if (error) {
        console.error(`Fehler beim Abrufen der Bonusfragen für ${qId}:`, error);
        return;
    }

    if (!correctPredictions || correctPredictions.length === 0) return;

    console.log(`[BONUS] Verteile ${pointsToAward} Punkte für ${qId} (Richtige Antwort: ${correctAnswer}) an ${correctPredictions.length} Operative(s).`);

    for (const pred of correctPredictions) {
        // 1. Setze die Punkte beim Tipp selbst
        await supabase.from('bonus_predictions').update({ points_earned: pointsToAward }).eq('id', pred.id);
        
        // 2. Addiere die Punkte auf den Gesamtscore des Spielers
        const { data: player } = await supabase.from('players').select('score').eq('id', pred.player_id).single();
        if (player) {
            await supabase.from('players').update({ score: player.score + pointsToAward }).eq('id', pred.player_id);
        }
    }
}

// --- MAIN UPDATE JOB ---
async function runUpdate() {
    console.log("Starte WM-Update-Job...");
    try {
        // ==========================================
        // TEIL 1: SPIELE AKTUALISIEREN & NORMALE PUNKTE BERECHNEN
        // ==========================================
        console.log("Hole Spiele von der API...");
        const matchesResponse = await fetch(MATCHES_URL, { headers: { 'X-Auth-Token': footballApiKey } });
        if (!matchesResponse.ok) throw new Error(`API Fehler (Matches): ${matchesResponse.status}`);
        
        const matchesData = await matchesResponse.json();
        const allMatches = matchesData.matches;
        
        for (const match of allMatches) {
            const matchId = match.id;
            const homeTeam = match.homeTeam?.name || 'TBD';
            const awayTeam = match.awayTeam?.name || 'TBD';
            const homeScore = match.score?.fullTime?.home ?? null;
            const awayScore = match.score?.fullTime?.away ?? null;
            const venueName = match.venue || 'TBD';
            
            const homeLogo = match.homeTeam?.crest || '';
            const awayLogo = match.awayTeam?.crest || '';
            
            const matchStage = match.stage || 'TBD';
            const matchGroup = match.group ? match.group.replace('GROUP_', '') : 'TBD';

            // Spiel in die Datenbank schreiben
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
                away_logo: awayLogo,
                stage: matchStage,
                match_group: matchGroup
            });

            if (matchError) console.error(`Fehler bei Spiel ${matchId}:`, matchError);

            // Reguläre Punkte berechnen (Nur für beendete Spiele nach regulärer Spielzeit)
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

        // ==========================================
        // TEIL 2: GRUPPENTABELLEN AKTUALISIEREN
        // ==========================================
        console.log("Hole Tabellenstände von der API...");
        const standingsResponse = await fetch(STANDINGS_URL, { headers: { 'X-Auth-Token': footballApiKey } });
        let currentStandings = []; 

        if (standingsResponse.ok) {
            const standingsData = await standingsResponse.json();
            const standingsToUpsert = [];
            const groupStandings = standingsData.standings.filter(s => s.type === 'TOTAL');

            for (const group of groupStandings) {
                const groupId = group.group ? group.group.replace('GROUP_', '') : 'TBD';
                let teamIndex = 1; 
                
                for (const teamRow of group.table) {
                    const tId = teamRow.team?.id ? teamRow.team.id.toString() : `TBD_${groupId}_${teamIndex}`;
                    const tName = teamRow.team?.name || `TBD (Group ${groupId})`;
                    const tCrest = teamRow.team?.crest || '';

                    const standingObj = {
                        team_id: tId,
                        team_name: tName,
                        group_id: groupId,
                        played: teamRow.playedGames || 0,
                        won: teamRow.won || 0,
                        drawn: teamRow.draw || 0,
                        lost: teamRow.lost || 0,
                        goals_for: teamRow.goalsFor || 0,
                        goals_against: teamRow.goalsAgainst || 0,
                        points: teamRow.points || 0,
                        crest: tCrest 
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
        console.log("Prüfe Bedingungen für Bonus-Auswertungen...");

        const groupMatches = allMatches.filter(m => m.stage === 'GROUP_STAGE');
        const r32Matches = allMatches.filter(m => m.stage === 'LAST_32');
        const finalMatch = allMatches.find(m => m.stage === 'FINAL');

        const groupsFinished = groupMatches.length > 0 && groupMatches.every(m => m.status === 'FINISHED');
        const r32Finished = r32Matches.length > 0 && r32Matches.every(m => m.status === 'FINISHED');
        const tournamentFinished = finalMatch && finalMatch.status === 'FINISHED';

        // --- BQ 2 & BQ 4: NACH DER GRUPPENPHASE ---
        if (groupsFinished && currentStandings.length > 0) {
            console.log("-> Gruppenphase beendet. Analysiere BQ 2 und BQ 4...");
            
            // BQ 4: Spannendste Gruppe (Geringste Punktdifferenz zwischen Platz 1 und 3)
            const groupDiffs = {};
            const groups = [...new Set(currentStandings.map(s => s.group_id))];
            
            groups.forEach(g => {
                const groupTeams = currentStandings.filter(s => s.group_id === g).sort((a,b) => b.points - a.points);
                if (groupTeams.length >= 3) {
                    groupDiffs[`GROUP ${g}`] = groupTeams[0].points - groupTeams[2].points;
                }
            });

            if (Object.keys(groupDiffs).length > 0) {
                const minDiff = Math.min(...Object.values(groupDiffs));
                const excitingGroups = Object.keys(groupDiffs).filter(g => groupDiffs[g] === minDiff);
                for (const gName of excitingGroups) {
                    await distributeBonusPoints('bq4', gName, 2);
                }
            }

            // BQ 2: Top 20 Nation scheidet in Vorrunde aus
            const TOP_20 = ["SPAIN", "FRANCE", "ARGENTINA", "ENGLAND", "PORTUGAL", "NETHERLANDS", "BRAZIL", "MOROCCO", "BELGIUM", "GERMANY", "CROATIA", "COLOMBIA", "SENEGAL", "MEXICO", "USA", "URUGUAY", "JAPAN", "SWITZERLAND"];
            
            // Finde alle Teams, die sich für die "Runde der 32" qualifiziert haben
            const advancedTeamNames = new Set(r32Matches.flatMap(m => [m.homeTeam?.name?.toUpperCase(), m.awayTeam?.name?.toUpperCase()]).filter(Boolean));
            
            for (const nation of TOP_20) {
                const teamInStandings = currentStandings.find(s => s.team_name.toUpperCase() === nation);
                // Wenn die Nation in der Tabelle ist, aber NICHT in den Last_32 Spielen auftaucht -> Ausgeschieden!
                if (teamInStandings && !advancedTeamNames.has(nation)) {
                    await distributeBonusPoints('bq2', nation, 2);
                }
            }
        }

        // --- BQ 6: NACH DER RUNDE DER 32 ---
        if (r32Finished && currentStandings.length > 0) {
            console.log("-> Runde der 32 beendet. Prüfe BQ 6...");
            
            // 1. Gruppensieger ermitteln
            const groups = [...new Set(currentStandings.map(s => s.group_id))];
            const groupWinners = [];
            groups.forEach(g => {
                const groupTeams = currentStandings.filter(s => s.group_id === g).sort((a,b) => b.points - a.points); 
                if (groupTeams.length > 0) groupWinners.push(groupTeams[0].team_name.toUpperCase());
            });

            // 2. Zählen, wie viele dieser Gruppensieger ihr LAST_32 Spiel verloren haben
            let eliminatedWinnersCount = 0;
            
            r32Matches.forEach(m => {
                const home = m.homeTeam?.name?.toUpperCase();
                const away = m.awayTeam?.name?.toUpperCase();
                
                // Wir zählen zur Sicherheit die Tore inkl. Verlängerung und Elfmeter
                const homeGoals = (m.score?.fullTime?.home || 0) + (m.score?.extraTime?.home || 0) + (m.score?.penalties?.home || 0);
                const awayGoals = (m.score?.fullTime?.away || 0) + (m.score?.extraTime?.away || 0) + (m.score?.penalties?.away || 0);
                
                const apiWinner = m.score?.winner; // 'HOME_TEAM' oder 'AWAY_TEAM'
                let loserTeam = null;

                if (apiWinner === 'HOME_TEAM') loserTeam = away;
                else if (apiWinner === 'AWAY_TEAM') loserTeam = home;
                else if (homeGoals > awayGoals) loserTeam = away;
                else if (awayGoals > homeGoals) loserTeam = home;

                if (loserTeam && groupWinners.includes(loserTeam)) {
                    eliminatedWinnersCount++;
                }
            });

            await distributeBonusPoints('bq6', eliminatedWinnersCount.toString(), 5);
        }

        // --- BQ 1, BQ 3, BQ 5: NACH DEM FINALE ---
        if (tournamentFinished) {
            console.log("-> Turnier beendet. Finale Auswertung BQ 1, 3 und 5...");
            
            // BQ 1: Weltmeister
            let wcWinner = null;
            if (finalMatch.score?.winner === 'HOME_TEAM') wcWinner = finalMatch.homeTeam?.name?.toUpperCase();
            else if (finalMatch.score?.winner === 'AWAY_TEAM') wcWinner = finalMatch.awayTeam?.name?.toUpperCase();
            
            if (wcWinner) {
                await distributeBonusPoints('bq1', wcWinner, 10);
            }

            // BQ 5: Anzahl 0:0 Spiele (Nur reguläre Spielzeit zählt laut deinen Regeln)
            const cleanSheets = allMatches.filter(m => m.status === 'FINISHED' && m.score?.fullTime?.home === 0 && m.score?.fullTime?.away === 0).length;
            await distributeBonusPoints('bq5', cleanSheets.toString(), 5);

            // BQ 3: Höchster Sieg (Tordifferenz nach 90 Minuten)
            let maxDiff = 0;
            let dominantNations = [];
            
            allMatches.forEach(m => {
                if (m.status === 'FINISHED') {
                    const hGoals = m.score?.fullTime?.home ?? 0;
                    const aGoals = m.score?.fullTime?.away ?? 0;
                    const diff = Math.abs(hGoals - aGoals);
                    
                    if (diff > maxDiff) {
                        maxDiff = diff;
                        dominantNations = [hGoals > aGoals ? m.homeTeam.name.toUpperCase() : m.awayTeam.name.toUpperCase()];
                    } else if (diff === maxDiff && diff > 0) {
                        dominantNations.push(hGoals > aGoals ? m.homeTeam.name.toUpperCase() : m.awayTeam.name.toUpperCase());
                    }
                }
            });

            const uniqueDominantNations = [...new Set(dominantNations)];
            for (const nation of uniqueDominantNations) {
                await distributeBonusPoints('bq3', nation, 2);
            }
        }

        console.log("Update-Job komplett und erfolgreich abgeschlossen!");
    } catch (error) {
        console.error("Schwerer Fehler beim Update-Job:", error);
    }
}

// --- STARTUP LOOP ---
// Der Bot läuft in GitHub Actions für ca. 3 Minuten (3 Zyklen à 60 Sekunden),
// da GitHub crons maximal alle 5 Minuten feuern können. Das schließt Lücken.
async function startLoop() {
    const cycles = 3;
    const waitTime = 60 * 1000;
    for (let i = 1; i <= cycles; i++) {
        await runUpdate();
        if (i < cycles) await delay(waitTime);
    }
}

startLoop();
