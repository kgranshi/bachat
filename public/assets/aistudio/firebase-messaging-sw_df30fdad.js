/* FCM background service worker — config embedded for closed-tab push */
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

var FB_SW_CONFIG = {"apiKey": "AIzaSyCOUaX1IIN7se2IdPN7U-TZV8fjlOYtuhc", "authDomain": "radhikakoirala-bachat.firebaseapp.com", "projectId": "radhikakoirala-bachat", "storageBucket": "radhikakoirala-bachat.firebasestorage.app", "messagingSenderId": "839076490296", "appId": "1:839076490296:web:b514e9c02d50d03b398acd"};

function initFb(cfg) {
  try {
    if (!firebase.apps.length) firebase.initializeApp(cfg || FB_SW_CONFIG);
    var messaging = firebase.messaging();
    messaging.onBackgroundMessage(function (payload) {
      var title = (payload.notification && payload.notification.title) ||
        (payload.data && payload.data.title) || 'समूह बचत';
      var body = (payload.notification && payload.notification.body) ||
        (payload.data && payload.data.body) || '';
      self.registration.showNotification(title, {
        body: body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        data: payload.data || {},
        tag: (payload.data && payload.data.tag) || 'samuha-chat'
      });
    });
  } catch (e) {
    console.warn('FCM SW init', e);
  }
}

initFb(FB_SW_CONFIG);

self.addEventListener('message', function (ev) {
  if (ev.data && ev.data.type === 'FB_CONFIG' && ev.data.config) {
    initFb(ev.data.config);
  }
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url && 'focus' in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});
