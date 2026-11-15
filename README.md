# Telsiz

İnternet ve hat olmadan, cihazdan cihaza mesaj ve dosya. Sunucu yok: iki cihaz aynı Wi‑Fi'da ya da aynı hotspot'tayken birbirinin ekranındaki QR kodu okutur, bağlantı doğrudan aralarında kurulur (WebRTC).

## Kullanım

1. İki cihaz aynı Wi‑Fi'a bağlanır. Wi‑Fi yoksa bir telefon hotspot açar, diğeri ona bağlanır.
2. Bir cihazda **BAĞLAN → KOD GÖSTER**, diğerinde **BAĞLAN → KOD OKUT**.
3. İkinci cihazın gösterdiği cevap kodu ilk cihaza okutulur. Bağlantı kurulur.

Üçüncü bir cihaz, bağlı cihazlardan herhangi biriyle aynı şekilde eşleşir; mesajlar ve dosyalar aradaki cihaz üzerinden herkese ulaşır. Bağlantı yokken yazılanlar saklanır ve ilk bağlantıda gider.

## Kurulum

- **Bu bilgisayarda:** `Telsiz.bat` dosyasına çift tıkla.
- **Telefonlarda:** `app/` klasörü HTTPS bir adrese (ör. GitHub Pages) yüklenmeli. Telefon o adresi internet varken bir kez açar ve ana ekrana ekler; sonrasında internetsiz açılır. Kamera ve çevrimdışı kayıt yalnızca HTTPS'te çalıştığı için bu adım zorunlu.

## Sınırlar

- Cihazlar aynı yerel ağda olmalı; menzil Wi‑Fi/hotspot menzili kadardır.
- Uygulama arka plana alınınca bağlantı kopabilir; kodlar yeniden okutulur.
- Dosyalar bellekte toplanır; telefonlarda birkaç yüz MB üstü riskli.
- Uygulama afetten **önce** her cihaza kurulmuş olmalı.

## Yapı

- `app/` — uygulamanın tamamı (statik dosyalar, derleme yok)
- `tools/serve.js` — bilgisayarda açmak için yerel sunucu (yalnızca 127.0.0.1)
- `tools/make-icons.js` — simgeleri `icon.svg`'den üretir

Kullanılan açık kaynak parçalar: qrcode-generator (MIT), jsQR (Apache-2.0), IBM Plex (OFL).
