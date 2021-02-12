export function scope(...scopes: string[]): string {
  return scopes.join(".");
}

let str = `
[ Friend Games ]
Sanae
Saghetti
Codyphobe
...
[ Public ]
Zombies
Coggers
Champers
...

loadpolus.games.ABCDEF
 - host_uuid: 14p143--34325424-y56-456-

KEYS loadpolus.games.*

request all games filter hostUuid in friends


let gamesForZombies: [Game, Game, Game, Game, Game]; // updated every 50ms
let gamesForCringe: [Game, Game, Game, Game, Game];  // updated every 50ms

script on redis:
1. filter by public
2. filter by not in progress
3. filter by zombies
4. filter by 0<players<10
filter games by gamemode = "zombies";


C => S : GetGameList
S => C : DummyGames[] [RandomServer, 196], [RandomServer, 197]
C => N : I want game 196
// if no 196 games
N => R : I want game 196
R => N : game XYZ, locks XYZ
N => C : Redirect [IP, PORT]
C => D : I want game 196
// we know this server has a 196
// new server needs a game


C => S : GetGameList
S => C : DummyGames[] [RandomServer, 196], [RandomServer, 197]
C => N : I want game 196
S => R : findGame("zombies")
R => S : [host, port, gameCode]
S => R : CreateMatchmakingTicket(clientIp, gameCode) // unnessacery
S => C : Redirect(host, port)
C => N : I want game 196
N => R : GetMatchmakingTicket(clientIp) // unnsessary
N => C : HostGameResponse(gameCode)
// wooo they joined


C => S : GetGameList
S => C : DummyGames[] [Self, 196], [Self, 197]
C => S : I want game 196
S => R : FindServerHosting(GameMode.Zombies)

final = []
for game in games:
    if game.gamemode == 1:
      final.append(game)
return final

R => S : [ip, port]
S => C : Redirect [ip, port]
C => N : Join 196
N => C : HostGame(gameCode)
N => C : JoinGame(gameCode)


C => MM : I want game list
MM => C : [RandomServer, 196], [RandomServer, 197], [RandomServer, 198], [RandomServer, 199]
C => R1 : I want 197
// R1 does not have 197
R1 => R : I want a server with game 197
R => R1 : AffirmedServer
R1 => C : Redirect { AffirmedServer }
C => AS : I want game 197
// game 197 has already started, thus the code returns no games, thus AS does not have 197
AS => C : HostGame(gameCode)
AS => C : JoinGame(gameCode)
`;

// just so it's used.
console.log(str);
