# mandarinOS imajı

Arch Linux tabanlı, değiştirilemez (immutable), A/B güncellemeli GNOME
dağıtımı. Uygulamalar Flatpak ile kurulur, mağaza **Bazaar**'dır. İmaj
[mkosi](https://github.com/systemd/mkosi) ile üretilir. Tasarım
[ParticleOS](https://github.com/systemd/particleos) ve systemd'nin
"Fitting Everything Together" yaklaşımını izler.

## Disk düzeni

```
ESP (1G, vfat)            systemd-boot + UKI'ler (her sürüm için bir .efi)
usr-verity-sig  A  ┐
usr-verity      A  ├─ mandarinOS_<sürüm>   salt okunur /usr (EROFS + dm-verity, imzalı)
usr             A  ┘
usr-verity-sig  B  ┐
usr-verity      B  ├─ ilk güncellemeye kadar "_empty"
usr             B  ┘
root (btrfs)              /etc katmanı, /var, /home  ← tek yazılabilir yer
```

- **/usr** salt okunurdur ve her açılışta dm-verity ile doğrulanır.
  `systemd.image_policy=usr=signed` imzası olmayan bir /usr'u bağlamaz.
- **/etc**, imajdaki fabrika kopyası (`/usr/share/factory/etc`) üzerine
  kök bölümündeki yazılabilir bir overlay katmanıdır. Değiştirilmemiş
  dosyalar güncellemeyle yenilenir; değiştirilenler katmanda kalır
  (`mkosi.initrd.conf/`, initrd'de kurulur).
- **/var** ilk açılışta `/usr/share/factory/var`'dan doldurulur.
- **pacman** yalnızca sorgu içindir (`pacman -Q`); paket kurulamaz.

## A/B güncellemeleri

1. `systemd-sysupdate.timer` güncelleme sunucusundaki `SHA256SUMS`'ı okur.
2. Yeni sürümün /usr, verity ve imza bölümleri **boştaki** yuvaya, yeni UKI
   ESP'ye yazılır (`mandarinOS_<v>_x86-64+3-0.efi`).
3. Kullanıcıya "yeniden başlatın" bildirimi gelir.
4. systemd-boot yeni sürümü en fazla 3 kez dener. `boot-complete.target`'a
   ulaşılırsa sürüm kalıcı olur; ulaşılamazsa eski yuvaya kendiliğinden döner.

Elle:

```sh
mandarin-update            # durum
mandarin-update check
mandarin-update update
mandarin-update reboot
mandarin-update rollback   # önceki sürümü varsayılan yap
```

Önyükleme menüsünde ayrıca **"Fabrika Ayarlarına Dön"** girişi vardır: kök
bölümünü siler, /usr'a dokunmaz.

## Uygulamalar: Flatpak + Bazaar

`/usr/share/flatpak/preinstall.d/mandarin.preinstall` ilk açılışta
(`mandarin-flatpak-preinstall.service`, ağ gelince) Flathub'dan şunları kurar:
Bazaar, Firefox, Flatseal, Loupe, Metin Düzenleyici, Papers, Hesap Makinesi.
Kullanıcı birini kaldırırsa yeniden kurulmaz. `mandarin-flatpak-update.timer`
uygulamaları günlük günceller. GNOME Yazılım ve PackageKit imajda yoktur.

## Derleme

Gerekenler: güncel mkosi (26+), Arch tabanlı bir makine veya mkosi'nin araç
ağacı (`ToolsTree=default`), ~30 GB boş alan.

```sh
cd mkosi
mkosi genkey                 # mkosi.key + mkosi.crt (bir kez; GÜVENLİ SAKLAYIN)
cp mkosi.local.conf.example mkosi.local.conf   # güncelleme adresini girin
mkosi -f build
mkosi vm                     # QEMU'da dene (UEFI + Secure Boot)
```

Aynı anahtar Secure Boot, UKI PCR imzası ve dm-verity imzası için kullanılır.
Anahtarı kaybederseniz kurulu sistemlere güncelleme gönderemezsiniz.

### Sürüm yayınlama

```sh
./release.sh <gpg-anahtar-kimliği>
```

`mkosi.output/release/<sürüm>/` altındaki dosyaları `MANDARIN_UPDATE_URL`
dizinine yükleyin. GPG ortak anahtarını `mkosi/keys/sysupdate-pubring.gpg`
olarak koyun ki imaj `SHA256SUMS.gpg`'yi doğrulasın:

```sh
gpg --export <anahtar-kimliği> > keys/sysupdate-pubring.gpg
```

Sürüm `mkosi.version`'dadır; `mkosi.bump` tarih tabanlı yeni sürüm üretir.

## Kurulum

```sh
mkosi burn /dev/sdX          # veya: zstd -d ...raw.zst | dd of=/dev/sdX
```

USB'den açın ve menüden **"mandarinOS'u Diske Kur"**u seçin.
`systemd-sysinstall` hedef diski sorar, `/usr/lib/repart.d` düzenine göre
bölümler, çalışan /usr'u A yuvasına blok blok kopyalar ve systemd-boot'u
kurar. İlk açılışta GNOME İlk Kurulum kullanıcıyı oluşturur.

Secure Boot açıksa makineyi **setup mode**'a alın; systemd-boot ilk açılışta
mandarinOS anahtarlarını kendiliğinden kaydeder (`SecureBootAutoEnroll=yes`).

## Dizinler

| Yol | İçerik |
| --- | --- |
| `mkosi.conf`, `mkosi.conf.d/` | Paketler, çekirdek komut satırı, imzalama |
| `mkosi.repart/` | Üretilen imajın (USB) bölümleri |
| `mkosi.extra/usr/lib/repart.d/` | Kurulu sistemin bölümleri (A/B + root) |
| `mkosi.sysupdate/` | `mkosi sysupdate` ile yerel güncelleme |
| `mkosi.postinst.chroot` | Marka, GNOME eklentileri, Sistem Ayarları, sysupdate.d |
| `mkosi.finalize` | /etc ve /var fabrika kopyaları |
| `mkosi.initrd.conf/` | initrd'de /etc overlay'i |
| `mkosi.uki-profiles/` | Kurulum ve fabrika ayarları önyükleme girişleri |
