# ROXX — HYROX完走診断

HYROX未経験者向けの完走診断Webアプリ。
本サービスは HYROX および Upsolut Sports GmbH とは関係のない非公式サービス。8項目の入力から、予測完走タイム・弱点2種目・
必要準備週数・トレーニングメニューを生成する。

## 構成

素のHTML/CSS/JS。ビルド不要。依存はGoogle Fontsのみ。

| ファイル | 役割 |
|---|---|
| `index.html` | アプリ本体（エンジン・画面・状態管理すべて） |
| `hyrox_engine_v0.json` | 係数テーブル（`index.html` 内の定数と対応） |
| `manifest.json` / `sw.js` | PWA |
| `legal/` | 特商法表記・プライバシーポリシー・利用規約 |
| `icon-192.png` / `icon-512.png` / `ogp.png` | アイコンとOGP画像 |

## 公開前に埋める値

`index.html` 内の以下の定数。特商法表記の事業者情報は記入済み。

| 場所 | 定数 | 内容 |
|---|---|---|
| `index.html` | `PAYMENT_LINK` | **テストリンク設定済み。** 審査通過後に本番リンク（`test_` なしのURL）へ差し替える |
| `index.html` | `GA4_ID` | GA4 測定ID（`G-` から始まる） |
| `index.html` | `SITE_URL` / OGPの`og:url`・`og:image` | 独自ドメイン確定後に差し替え |

`PAYMENT_LINK` / `GA4_ID` は空でも動作する（決済ボタンは「準備中」表示、
計測は無効）。

## ローカル確認

```
npx --yes http-server . -p 4179 -c-1
```

## 保存データ

すべて端末内の localStorage。サーバーには何も送らない。

| キー | 内容 |
|---|---|
| `hx_answers` | 入力8項目 |
| `hx_result` | 予測タイム・必要週数・弱点・週締め済みフラグ |
| `hx_log` | 実施ログ |
| `hx_week` | 現在の週番号 |
| `hx_paid` | 課金フラグ |

「入力をやり直す」は `hx_paid` を残して他を削除する。
