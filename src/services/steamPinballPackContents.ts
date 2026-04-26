/**
 * Curated pack-contents map for the Steam Pinball importer.
 *
 * Source-of-truth: tmp/pack-contents-draft.md (user-curated). Each top-level
 * key is a Steam DLC appId; the value is the list of constituent table names
 * Zen / Zaccaria ship inside that pack. The importer expands a DLC found here
 * into N upserts (one per table) tagged with the parent product's platform,
 * skipping the pack name itself. Names are kept as user-curated; the importer
 * runs them through `cleanTableName` at upsert time to strip TM/R/C/SM symbols.
 *
 * Star Wars Pinball VR (1530770) is the special case — its base game has
 * tables baked in (no DLC API), so it gets a separate seed-list constant.
 *
 * To regenerate: edit tmp/pack-contents-draft.md, then run
 *   node tmp/emit-pack-data-ts.js > src/services/steamPinballPackContents.ts
 */

/** Steam DLC appId → list of constituent table names within that pack. */
export const PACK_CONTENTS: Record<number, string[]> = {
    // Pinball FX Classic VR - Season 1 Pack
    549070: [
        'Wild West Rampage',
        'BioLab',
        'Paranormal',
    ],
    // Pinball FX Classic - Marvel Pinball Original Pack
    646660: [
        'Wolverine',
        'Blade',
        'Iron Man',
    ],
    // Pinball FX Classic - Marvel Pinball Vengeance and Virtue Pack
    646661: [
        'GHOST RIDER',
        'MOON KNIGHT',
        'THOR',
        'X-MEN',
    ],
    // Pinball FX Classic - Marvel Pinball Avengers Chronicles
    646662: [
        'World War Hulk',
        'Fear Itself',
        'The Infinity Gauntlet',
        'Marvel\'s The Avengers',
    ],
    // Pinball FX Classic - Marvel's Women of Power
    646663: [
        'Spider-Gwen',
        'Squirrel Girl',
        'Black Widow',
        'Captain Marvel',
    ],
    // Pinball FX Classic - Star Wars™ Pinball
    646664: [
        'Star Wars™: Episode V: - The Empire Strikes Back™',
        'Star Wars™: The Clone Wars™',
        'Boba Fett',
    ],
    // Pinball FX Classic - Star Wars™ Pinball: Balance of the Force
    646665: [
        'Star Wars: Episode VI Return of the Jedi',
        'Starfighter Assault',
        'Darth Vader',
    ],
    // Pinball FX Classic - Star Wars™ Pinball: Heroes Within
    646666: [
        'Star Wars™ Pinball: Droids™',
        'Han Solo',
        'Star Wars™ Pinball: Masters of the Force',
        'Star Wars™ Pinball: Episode IV A New Hope',
    ],
    // Pinball FX Classic - Star Wars™ Pinball: The Force Awakens Pack
    646667: [
        'Star Wars™ Pinball: The Force Awakens™',
        'Star Wars™ Pinball: Might of the First Order',
    ],
    // Pinball FX Classic - Bethesda® Pinball
    646668: [
        'Fallout',
        'DOOM',
        'The Elder Scrolls V: Skyrim',
    ],
    // Pinball FX Classic - Aliens vs Pinball
    646670: [
        'Aliens',
        'Alien: Isolation',
        'Alien vs. Predator',
    ],
    // Pinball FX Classic - Iron & Steel Pack
    646671: [
        'CastleStorm',
        'Wild West Rampage',
    ],
    // Pinball FX Classic - Zen Classics
    646672: [
        'El Dorado',
        'Shaman',
        'Tesla',
        'V12',
    ],
    // Pinball FX Classic - Core Collection
    646673: [
        'Pasha',
        'Secrets of the deep',
        'Biolab',
        'Rome',
    ],
    // Pinball FX Classic - Marvel Pinball: Marvel Legends Pack
    657420: [
        'Captain America',
        'Doctor Strange',
        'Fantastic Four',
    ],
    // Pinball FX Classic - Marvel Pinball: Heavy Hitters
    657421: [
        'Civil War',
        'Deadpool',
        'Venom',
    ],
    // Pinball FX Classic - Marvel Pinball: Cinematic Pack
    657422: [
        '"Marvel\'s Avengers: Age of Ultron"',
        '"Marvel\'s Ant-Man."',
    ],
    // Pinball FX Classic - Medieval Pack
    657423: [
        'Epic Quest',
        'Excalibur',
    ],
    // Pinball FX Classic - Sci-Fi Pack
    657424: [
        'Mars',
        'Paranormal',
        'Earth Defense',
    ],
    // Pinball FX Classic - Universal Classics™ Pinball
    715110: [
        'Back to the Future',
        'Jaws',
        'E.T.',
    ],
    // Pinball FX Classic - Star Wars™ Pinball:  Unsung Heroes
    718800: [
        'Star Wars™ Pinball: Rogue One™',
        'Star Wars Rebels™',
    ],
    // Pinball FX Classic - Carnivals and Legends
    750060: [
        'Adventure Land',
        'Son of Zeus',
    ],
    // Pinball FX Classic - Jurassic World™ Pinball
    782110: [
        'Jurassic Park',
        'Jurassic Park Pinball Mayhem',
        'Jurassic World',
    ],
    // Pinball FX Classic - Star Wars™ Pinball: The Last Jedi™
    836820: [
        'Star Wars™ Pinball: The Last Jedi',
        'Star Wars™ Pinball: Ahch-To Island',
    ],
    // Pinball FX Classic VR - Universal Classics™ Pinball
    865320: [
        'Jaws Pinball',
        'Back to the Future™ Pinball',
        'E.T. Pinball',
    ],
    // Pinball FX Classic - Star Wars™ Pinball: Solo
    931640: [
        'Star Wars™ Pinball: Solo',
        'Star Wars™ Pinball: Calrissian Chronicles',
        'Star Wars™ Pinball: Battle of Mimban',
    ],
    // Pinball FX Classic - Williams™ Pinball: Volume 1
    947000: [
        'THE GETAWAY',
        'JUNK YARD™',
        'MEDIEVAL MADNESS™',
    ],
    // Pinball FX Classic - Williams™ Pinball: Volume 2
    984180: [
        'BLACK ROSE',
        'ATTACK FROM MARS',
        'THE PARTY ZONE',
    ],
    // Pinball FX Classic - Williams™ Pinball: Volume 3
    1044440: [
        'THEATRE OF MAGIC',
        'SAFE CRACKER',
        'THE CHAMPION PUB',
    ],
    // Pinball FX Classic - Williams™ Pinball: Volume 4
    1086760: [
        'WHITE WATER',
        'RED AND TED\'S ROAD SHOW',
        'HURRICANE',
    ],
    // Pinball FX Classic - Williams™ Pinball: Universal Monsters Pack
    1167870: [
        'MONSTER BASH',
        'CREATURE FROM THE BLACK LAGOON',
    ],
    // Pinball FX Classic - Williams™ Pinball: Volume 5
    1203510: [
        'TALES OF THE ARABIAN NIGHTS',
        'CIRQUS VOLTAIRE',
        'NO GOOD GOFERS',
    ],
    // Pinball FX Classic - Williams™ Pinball: Volume 6
    1450220: [
        'FUNHOUSE',
        'SPACE STATION',
        'DR. DUDE AND HIS EXCELLENT RAY™',
    ],
    // Pinball FX Classic - Indiana Jones™: The Pinball Adventure
    1849550: [
        'Indiana Jones: The Pinball Adventure',
    ],
    // Pinball FX - Star Wars™ Pinball
    2351792: [
        'Star Wars: Episode V The Empire Strikes Back',
        'Star Wars: The Clone Wars',
        'Boba Fett',
    ],
    // Pinball FX - Star Wars™ Pinball Balance of the Force
    2351793: [
        'Star Wars: Episode VI Return of the Jedi',
        'Starfighter Assault',
        'Darth Vader',
    ],
    // Pinball FX - Star Wars™ Pinball:  Thrill of the Hunt
    2351794: [
        'The Mandalorian',
        'Classic Collectibles',
    ],
    // Pinball FX - Universal Classics™ Pinball
    2351795: [
        'Back to the Future™',
        'Jaws™',
        'E.T.™',
    ],
    // Pinball FX - Jurassic World™ Pinball
    2351796: [
        'Jurassic Park™ Pinball',
        'Jurassic Park Pinball Mayhem™',
        'Jurassic World™ Pinball',
    ],
    // Pinball FX - Secrets & Shadows Pack
    2351798: [
        'CURSE OF THE MUMMY',
        'PINBALL NOIR',
        'SKY PIRATES',
    ],
    // Pinball FX - Williams Pinball: Universal Monsters Pack
    2351799: [
        'MONSTER BASH',
        'CREATURE FROM THE BLACK LAGOON',
    ],
    // Pinball FX - Indiana Jones™:  The Pinball Adventure
    2351802: [
        'Indiana Jones: The Pinball Adventure',
    ],
    // Pinball FX - DreamWorks Pinball
    2351808: [
        'DreamWorks Trolls Pinball',
        'DreamWorks Kung Fu Panda Pinball',
        'DreamWorks How to Train Your Dragon Pinball',
    ],
    // Pinball FX - Garfield Pinball
    2351840: [
        'Garfield Pinball',
    ],
    // Pinball FX - MY LITTLE PONY Pinball
    2351841: [
        'MY LITTLE PONY Pinball',
    ],
    // Pinball FX - Godzilla vs. Kong Pinball Pack
    2351844: [
        'GODZILLA PINBALL',
        'KONG PINBALL',
        'GODZILLA vs KONG PINBALL',
    ],
    // Pinball FX - Grimm Tales
    2351940: [
        'Grimm Tales',
    ],
    // Pinball FX - Wrath of the Elder Gods
    2351941: [
        'Wrath of the Elder Gods',
    ],
    // Pinball FX - Star Wars™ Pinball:  Heroes Within
    2357270: [
        'Star Wars™ Pinball: Droids™',
        'Star Wars™ Pinball: Episode IV A New Hope',
    ],
    // Pinball FX - Star Wars™ Pinball:  The Force Awakens Pack
    2357271: [
        'Star Wars™ Pinball: The Force Awakens™',
        'Star Wars™ Pinball: Might of the First Order',
    ],
    // Pinball FX - Star Wars™ Pinball:  Unsung Heroes
    2357272: [
        'Star Wars™ Pinball: Rogue One™',
        'Star Wars™ Pinball: Star Wars Rebels™',
    ],
    // Pinball FX - Star Wars™ Pinball: The Last Jedi
    2357273: [
        'Star Wars™ Pinball: The Last Jedi',
        'Star Wars™ Pinball: Ahch-To Island',
    ],
    // Pinball FX - Star Wars™ Pinball: Solo Pack
    2357274: [
        'Star Wars™ Pinball: Solo',
        'Star Wars™ Pinball: Calrissian Chronicles',
        'Star Wars™ Pinball: Battle of Mimban',
    ],
    // Pinball FX - Marvel Pinball Original Pack
    2357275: [
        'Wolverine',
        'Blade',
        'Iron Man',
        'Spider-Man',
    ],
    // Pinball FX - Marvel Pinball:  Marvel Legends Pack
    2357276: [
        'Captain America',
        'Doctor Strange',
        'Fantastic Four',
    ],
    // Pinball FX - Marvel Pinball:  Vengeance and Virtue
    2357277: [
        'GHOST RIDER',
        'MOON KNIGHT',
        'THOR',
        'X-MEN',
    ],
    // Pinball FX - Marvel Pinball:  Heavy Hitters
    2357278: [
        'Civil War',
        'Venom',
        'Deadpool',
    ],
    // Pinball FX - Marvel Pinball:  Cinematic Pack
    2357279: [
        'Marvel\'s Guardians of the Galaxy',
        'Marvel\'s Avengers: Age of Ultron',
        'Marvel\'s Ant-Man',
    ],
    // Pinball FX - Marvel Pinball:  Avengers Chronicles
    2357320: [
        'Marvel\'s The Avengers',
        'Fear Itself',
        'The Infinity Gauntlet',
        'World War Hulk',
    ],
    // Pinball FX - Marvel's Women of Power
    2357321: [
        'Marvel\'s Women of Power: A-Force',
        'Marvel\'s Women of Power: Champions',
    ],
    // Pinball FX - Carnivals & Legends
    2370401: [
        'Adventure Land',
        'Son of Zeus',
    ],
    // Pinball FX - Core Collection
    2370402: [
        'Pasha',
        'Biolab',
        'Rome',
        'Secrets of the deep',
    ],
    // Pinball FX - Williams Pinball Volume 1
    2370405: [
        'THE GETAWAY',
        'JUNK YARD™',
        'MEDIEVAL MADNESS™',
    ],
    // Pinball FX - Williams Pinball Volume 2
    2370406: [
        'BLACK ROSE',
        'ATTACK FROM MARS',
        'THE PARTY ZONE',
    ],
    // Pinball FX - Williams Pinball Volume 3
    2370407: [
        'THEATRE OF MAGIC',
        'SAFE CRACKER',
        'THE CHAMPION PUB',
    ],
    // Pinball FX - Williams Pinball Volume 4
    2370408: [
        'WHITE WATER',
        'RED AND TED\'S ROAD SHOW',
        'HURRICANE',
    ],
    // Pinball FX - Williams Pinball Volume 5
    2370409: [
        'TALES OF THE ARABIAN NIGHTS',
        'CIRQUS VOLTAIRE',
        'NO GOOD GOFERS',
    ],
    // Pinball FX - Williams Pinball Volume 6
    2370410: [
        'FUNHOUSE',
        'SPACE STATION',
        'DR. DUDE AND HIS EXCELLENT RAY™',
    ],
    // Pinball FX - Honor and Legacy Pack
    2452710: [
        'A SAMURAI\'S VENGEANCE',
        'VERNE\'S MYSTERIOUS ISLAND',
    ],
    // Pinball FX - South Park™ Pinball
    2590200: [
        'South Park Pinball',
    ],
    // Pinball FX - Star Trek™ Pinball
    2677500: [
        'Star Trek™ Pinball: Kelvin Timeline',
        'Star Trek™ Pinball: Discovery',
        'Star Trek™ Pinball: Deep Space Nine',
    ],
    // Pinball FX - Game Night Pinball Volume 1
    2677510: [
        'TERRAFORMING MARS PINBALL',
        'GLOOMHAVEN',
        'EXPLODING KITTENS',
    ],
    // Pinball FX - Charity Pack
    2677520: [
        'PROJECT PINBALL',
        'BUDAPEST PINBALL MUSEUM',
    ],
    // Pinball FX - Universal Pinball: TV Classics
    2915800: [
        'Xena: Warrior Princess Pinball',
        'Knight Rider Pinball',
        'Battlestar Galactica Pinball',
    ],
    // Pinball FX - Williams™ Pinball Volume 8
    3225380: [
        'BLACK KNIGHT 2000',
        'BANZAI RUN',
        'EARTHSHAKER',
    ],
    // Pinball FX - Williams™ Pinball Volume 9
    3913690: [
        'TAXI',
        'WHO dunnit',
        'PIN-BOT',
    ],
    // Pinball FX Midnight - Bethesda® Pinball
    4321450: [
        'DOOM',
        'The Elder Scrolls V: Skyrim',
        'Fallout',
    ],
    // Pinball FX - Williams™ Pinball Volume 10
    4511550: [
        'COMET',
        'FIRE!',
        'DINER',
    ],
};

/**
 * Star Wars Pinball VR (Steam appId 1530770) — base-game-built-in table list.
 * Parent app has no DLC, so the importer seeds straight from this list when it
 * encounters this product.
 */
export const SW_VR_SEED_TABLES: string[] = [
    'The Mandalorian',
    'Star Wars Episode IV: A New Hope',
    'Star Wars Episode V: The Empire Strikes Back',
    'Star Wars Episode VI: Return of the Jedi',
    'Rogue One: A Star Wars Story',
    'Star Wars Rebels',
    'Masters of the Force',
    'Classic Collectibles',
];
