// Two languages. The page is written in Russian; English replaces it when
// the visitor's browser isn't Russian-speaking and their clock isn't in a
// CIS time zone (a static site can't see the country, the time zone is the
// region it does know). A choice made with the RU/EN button wins and is kept.
(function () {
  'use strict';

  var EN = {
    pageTitle: 'MC Launcher — play together',
    pageDesc: 'A free Minecraft launcher: Java and Bedrock in one window, parties with voice chat, Xbox friends, an in-game overlay and cosmetics that show right in the game.',
    toTop: 'MC Launcher — back to top',
    sections: 'Sections',
    langSwitch: 'Переключить на русский',
    langOther: 'RU',
    navFeatures: 'Features',
    navCosmetics: 'Cosmetics',
    navRedeem: 'Redeem',
    navTopup: 'Top up',
    navFaq: 'FAQ',
    download: 'Download',
    downloadShort: 'Download',
    kicker: 'A free Minecraft launcher',
    title: 'Play together.',
    lead: 'Java and Bedrock in one window, parties with voice chat, Xbox friends, an in-game overlay — and pets that fly after you.',
    downloadWin: 'Download for Windows',
    haveCode: 'I have a code',
    meta: 'Windows 10/11 · 64-bit · Free',
    altLobby: 'The MC Launcher main screen: a player with angel wings and a halo in the lobby',
    dragHint: 'Pull the picture by its edge',
    featuresTitle: 'What it does',
    featuresSub: 'Everything you need to play with friends — in one window.',
    f1t: 'Parties of up to 5',
    f1: 'A code or a link and your friends are in your lobby. The leader presses Play and everyone goes in together.',
    f2t: 'Voice chat',
    f2: 'With noise suppression. In the game you hear the players near you — louder when they are closer.',
    f3t: 'Java and Bedrock',
    f3: 'Both editions in one list, servers with their ping and icons.',
    f7t: 'In-game overlay',
    f7: 'On F7: voice, lobby chat, screenshots, video recording and a replay of the last minutes.',
    f8t: 'Zoom and brightness',
    f8: 'Smooth zoom with the wheel, light in caves, auto-sprint and low fire — in both editions.',
    f9t: 'Game fixer',
    f9: 'The game crashed? The bug finds the mod that broke it and turns it off in one click.',
    f4t: 'Xbox friends',
    f4: "See who's online and who's playing. Chat with friends right in the launcher.",
    f5t: 'Cosmetics in game',
    f5: 'Wings, halos, hats and pets — seen by everyone who plays through MC Launcher.',
    f6t: 'Mods, no hassle',
    f6: 'Fabric, Forge, NeoForge and Quilt. The launcher fetches the right Java itself.',
    cosTitle: 'Cosmetics',
    cosSub: 'Pets and packs, each with a story of its own. They come from event quests, from codes or for coins in the launcher.',
    cosNew: 'New',
    kindPet: 'Pet',
    kindPack: 'Pack',
    sWarden: 'The smallest Warden of the Ancient City. Ran away because nobody believed he was scary. Hears everything with his ears — even you sneaking to a chest.',
    sCapybara: 'Lived happily in the swamp until a Creeper blew up her house. Now she floats after you, pretending everything is under control.',
    sCoalie: 'Popped out of a campfire instead of coal — and liked it out here. Scared of water and Endermen, but somehow not of you.',
    sFallen: 'The wings went black after a night in the Nether with no bed. The halo stayed — with horns now, for respect.',
    sDevil: 'A little devil from a bastion traded all the piglins’ gold for pink dye. The piglins still can’t tell who tricked whom.',
    sAngel: 'Rumour says they’re given to those who never pillared up on dirt. Kidding — you can just get them.',
    eventKind: 'Event · all October',
    eventTitle: 'Halloween',
    eventSub: 'A witch hat, a broom, bat wings, an axe in the head and a hockey mask — for quests in the game. Open the launcher, the quests are waiting.',
    redeemTitle: 'Redeem a code',
    redeemSub: 'Got a code for cosmetics? Enter it — the launcher opens with it, you only press Activate. The cosmetics go to your Xbox account.',
    codeAria: 'Activation code',
    redeemBtn: 'Activate',
    r1: 'Install MC Launcher and sign in with Xbox.',
    r2: 'Enter the code here or in the launcher: Settings → Activation code.',
    r3: 'The cosmetics show up in Skins — put them on. Every code works once.',
    codeBad: 'A code looks like MCL-XXXX-XXXX-XXXX.',
    codeOpening: 'Opening MC Launcher… Press Activate there. Nothing happened? Install the launcher first:',
    topupTitle: 'Top up',
    topupSub: 'Coins for cosmetics in the launcher. Top-ups open soon — until then cosmetics come from event quests and codes.',
    coinsWord: 'coins',
    soon: 'Soon',
    best: 'Best deal',
    topupNote: 'The launcher was and stays free. Cosmetics are only for looks and don’t affect the game.',
    faqTitle: 'FAQ',
    q1: 'Is it really free?',
    a1: 'Yes. The launcher is free, with no ads and no subscriptions. Cosmetics are only for looks and do not affect the game.',
    q8: 'Where do I get a cosmetics code?',
    a8: 'We give codes away in events and giveaways. Every code works once; if you already have the pack, the code isn’t spent — give it to a friend.',
    q2: 'Do I need a Minecraft licence?',
    a2: "With a Microsoft account that owns Minecraft you play as usual, on any server. With an Xbox account without Java it runs offline: singleplayer, LAN and offline-mode servers work, licensed servers won't let you in.",
    q9: 'Who sees my cosmetics?',
    a9: 'Everyone who plays through MC Launcher — in Java and in Bedrock. On Bedrock servers with packs of their own (The Hive, for one) they don’t show yet.',
    q3: 'Why do Windows or the browser warn about the file?',
    a3: "The installer doesn't have a paid code signature yet, so SmartScreen sees an “unknown publisher”. Click More info → Run anyway. In the browser — Keep.",
    q5: 'How do I update?',
    a5: 'You don’t — the launcher downloads a new version in the background and installs it when you close it.',
    q6: 'What systems does it run on?',
    a6: 'Windows 10 and 11, 64-bit. Bedrock needs Minecraft for Windows installed.',
    finalTitle: 'Call your friends.',
    downloadApp: 'Download MC Launcher',
    disclaimer: 'An unofficial launcher. Not a Minecraft product and not affiliated with Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Synergies AB.',
    launcher: 'Launcher',
    project: 'Project',
    source: 'Source code',
  };
  var RU_EXTRA = {
    pageTitle: 'MC Launcher — играй вместе',
    langSwitch: 'Switch to English',
    langOther: 'EN',
    version: 'Версия {v}',
    mb: '{n} МБ',
    codeBad: 'Код выглядит так: MCL-XXXX-XXXX-XXXX.',
    codeOpening: 'Открываем MC Launcher… Нажми там «Активировать». Ничего не открылось? Сначала установи лаунчер:',
  };

  var RU_LANG = /^(ru|uk|be|kk)\b/i;
  var CIS_ZONE = /^(Europe\/(Moscow|Kaliningrad|Samara|Volgograd|Saratov|Ulyanovsk|Astrakhan|Kirov|Minsk|Kiev|Kyiv|Simferopol|Chisinau)|Asia\/(Yekaterinburg|Omsk|Novosibirsk|Barnaul|Tomsk|Novokuznetsk|Krasnoyarsk|Irkutsk|Chita|Yakutsk|Khandyga|Vladivostok|Ust-Nera|Magadan|Sakhalin|Srednekolymsk|Kamchatka|Anadyr|Almaty|Qostanay|Aqtobe|Aqtau|Atyrau|Oral|Qyzylorda|Bishkek|Tashkent|Samarkand|Dushanbe|Ashgabat|Baku|Yerevan))$/;

  function saved() {
    try {
      var v = localStorage.getItem('mcl-lang');
      return v === 'ru' || v === 'en' ? v : '';
    } catch (e) {
      return '';
    }
  }

  function detect() {
    var langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']);
    if (RU_LANG.test(langs[0] || '')) return 'ru';
    var zone = '';
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) { /* no Intl */ }
    return CIS_ZONE.test(zone) ? 'ru' : 'en';
  }

  var ru = {}; // the page's own Russian, read once from the HTML
  var listeners = [];
  var lang = saved() || detect();
  document.documentElement.lang = lang;
  if (lang === 'en') document.documentElement.classList.add('i18n-pending');

  function t(key, vars) {
    var s = (lang === 'en' ? EN[key] : RU_EXTRA[key] || ru[key]) || '';
    for (var k in vars || {}) s = s.replace('{' + k + '}', vars[k]);
    return s;
  }

  function each(attr, fn) {
    var list = document.querySelectorAll('[' + attr + ']');
    for (var i = 0; i < list.length; i++) fn(list[i], list[i].getAttribute(attr));
  }

  function remember() {
    each('data-t', function (el, k) { if (!(k in ru)) ru[k] = el.innerHTML; });
    each('data-t-alt', function (el, k) { if (!(k + ':alt' in ru)) ru[k + ':alt'] = el.getAttribute('alt'); });
    each('data-t-aria', function (el, k) { if (!(k + ':aria' in ru)) ru[k + ':aria'] = el.getAttribute('aria-label'); });
    var desc = document.querySelector('meta[name="description"]');
    ru.pageDesc = desc ? desc.content : '';
  }

  function apply() {
    var en = lang === 'en';
    each('data-t', function (el, k) { el.innerHTML = en ? EN[k] || ru[k] : ru[k]; });
    each('data-t-alt', function (el, k) { el.setAttribute('alt', en ? EN[k] || ru[k + ':alt'] : ru[k + ':alt']); });
    each('data-t-aria', function (el, k) { el.setAttribute('aria-label', en ? EN[k] || ru[k + ':aria'] : RU_EXTRA[k] || ru[k + ':aria']); });
    document.title = t('pageTitle');
    var desc = document.querySelector('meta[name="description"]');
    if (desc) desc.content = en ? EN.pageDesc : ru.pageDesc;
    document.documentElement.lang = lang;
    document.documentElement.classList.remove('i18n-pending');
    for (var i = 0; i < listeners.length; i++) listeners[i](lang);
  }

  function set(next) {
    lang = next === 'en' ? 'en' : 'ru';
    try {
      localStorage.setItem('mcl-lang', lang);
    } catch (e) { /* not kept, fine */ }
    apply();
  }

  document.addEventListener('DOMContentLoaded', function () {
    remember();
    apply();
    var btn = document.querySelector('.lang');
    if (btn) btn.addEventListener('click', function () { set(lang === 'en' ? 'ru' : 'en'); });
  });

  window.MCL_I18N = {
    t: t,
    lang: function () { return lang; },
    onChange: function (fn) { listeners.push(fn); },
  };
})();
