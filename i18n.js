// Two languages. The page is written in Russian; English replaces it when
// the visitor's browser isn't Russian-speaking and their clock isn't in a
// CIS time zone (a static site can't see the country, the time zone is the
// region it does know). A choice made with the RU/EN button wins and is kept.
(function () {
  'use strict';

  var EN = {
    pageTitle: 'MC Launcher — play together',
    pageDesc: 'A free Minecraft launcher: Java and Bedrock in one window, parties of up to 5 with voice chat, Xbox friends, skins that show in the game, and Discord.',
    toTop: 'MC Launcher — back to top',
    sections: 'Sections',
    langSwitch: 'Переключить на русский',
    langOther: 'RU',
    navFeatures: 'Features',
    navShots: 'Screenshots',
    navFaq: 'FAQ',
    download: 'Download',
    kicker: 'A free Minecraft launcher',
    title: 'Play<br>together.',
    lead: 'Java and Bedrock in one window, parties of up to 5 with voice chat, Xbox friends and skins that show right in the game.',
    downloadWin: 'Download for Windows',
    latest: 'Latest version',
    metaFree: 'Windows 10/11, 64-bit · Free',
    metaSys: 'Windows 10/11, 64-bit',
    altLobby: 'The MC Launcher lobby: four friends in a party standing together in 3D',
    featuresTitle: 'What it does',
    featuresSub: 'Everything to get your friends together and into the game with one button.',
    f1t: 'Parties of up to 5',
    f1: 'A code or a link and your friends are in your lobby. The leader presses Play and everyone lands on the same version and the same server.',
    f2t: 'Voice chat',
    f2: 'Built in, with RNNoise noise suppression. Open mic or push-to-talk, and a volume for everyone.',
    f3t: 'Xbox friends',
    f3: "See who's online and who's playing Minecraft. Join a friend's open lobby in one click, no code.",
    f4t: 'Skins show in game',
    f4: "Even for guests. Party friends see each other's skins on servers that set none — from 1.8 to 26.x.",
    f5t: 'Java and Bedrock',
    f5: 'Both editions in one list. Bedrock servers with ping and icons, one skin for both.',
    f6t: 'Mods, no hassle',
    f6: 'Fabric, Forge, NeoForge and Quilt, every installation in its own folder. The launcher fetches the right Java itself.',
    f7t: 'Discord',
    f7: 'Your profile shows "Playing MC Launcher" with the version and party. Friends can ask to join your lobby straight from Discord.',
    f8t: 'Your style',
    f8: 'A 3D lobby with your skin and emotes, 13 accent colours or your own, holiday particles.',
    f9t: 'Light',
    f9: 'Smooth on any monitor, and while you play it barely touches the CPU or GPU.',
    shotsTitle: 'How it looks',
    s1: 'Party, voice and chat',
    s2: 'Xbox friends',
    s3: 'Skin library',
    s4: 'Worlds and servers',
    s5: 'Parties by code',
    s6: 'Pick your colour',
    s1d: 'Your friends stand next to you in the lobby, with voice and chat in the side panel.',
    s2d: "Who's online, what they're playing and whose lobby is open — join in one click.",
    s3d: "Add a PNG or take any player's skin by name, and spin it around in 3D.",
    s4d: 'Your latest worlds with their icons and servers with ping, right by the Play button.',
    s5d: 'One code for everyone: the leader picks the version and server, the rest follow.',
    s6d: '13 accent colours or your own — the whole launcher changes at once.',
    sliderLabel: 'Launcher screenshots',
    prev: 'Previous',
    next: 'Next',
    stepsTitle: 'Getting started',
    st1t: 'Download',
    st1: 'One installer, about 110 MB. The launcher downloads the game itself.',
    st2t: 'Install',
    st2: 'If Windows says "Windows protected your PC", press "More info" → "Run anyway".',
    st3t: 'Play',
    st3: 'Sign in with Microsoft, Xbox or as a guest, invite friends to a party and press Play.',
    faqTitle: 'FAQ',
    q1: 'Is it really free?',
    a1: 'Yes. The launcher is free, with no ads and no subscriptions.',
    q2: 'Do I need to own Minecraft?',
    a2: "With a Microsoft account that owns Minecraft you play as usual, on any server. With an Xbox account without Java, or as a guest, Java starts offline: singleplayer, LAN and offline-mode servers work, licensed servers won't let you in.",
    q3: 'Why do Windows or the browser warn about the file?',
    a3: 'The installer has no paid code signature yet, so SmartScreen sees an "unknown publisher". Press "More info" → "Run anyway". In the browser, choose "Keep".',
    q4: 'Is my account safe?',
    a4: 'You sign in on Microsoft\'s own page; the launcher never sees your password. Tokens are kept encrypted by Windows, and parties and voice are encrypted.',
    q5: 'How do I update?',
    a5: 'Download the new version here and install it over the old one — your settings, skins and installations stay.',
    q6: 'What does it run on?',
    a6: 'Windows 10 and 11, 64-bit. Bedrock needs Minecraft for Windows installed.',
    finalTitle: 'Bring your friends.',
    downloadApp: 'Download MC Launcher',
    allVersions: 'All versions',
    disclaimer: 'An unofficial launcher. Not a Minecraft product and not affiliated with Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Synergies AB.',
    close: 'Close',
    version: 'Version {v}',
    mb: '{n} MB',
  };
  var RU_EXTRA = {
    pageTitle: 'MC Launcher — играй вместе',
    langSwitch: 'Switch to English',
    langOther: 'EN',
    version: 'Версия {v}',
    mb: '{n} МБ',
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
