# Claude Branch Tree Viewer

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatible-green.svg)
![Claude.ai](https://img.shields.io/badge/Claude.ai-userscript-purple.svg)

**[English](README.md)**

> Claude.aiの会話ブランチ（分岐）をツリーとして可視化するTampermonkeyスクリプト。任意のメッセージへのジャンプ、サブツリーの折り畳み、ノードへのラベル付けなどが可能。

Claude.aiでは過去のメッセージを編集すると会話が分岐するが、分岐の全体像を確認する手段が用意されていない。このスクリプトはフローティングパネルで会話ツリーを表示し、全体構造や今どのブランチにいるかを把握し、やりとりに名前を付けられるようにする。

<img width="746" height="541" alt="Branch Tree Viewer スクリーンショット" src="https://github.com/user-attachments/assets/1584c0bb-23bc-40ca-8274-9dda28ebbc01" />

## 機能

### ツリー表示

会話のユーザー発言を抽出し、階層ツリーとして表示する。現在アクティブなブランチはハイライトされる。

### 分岐数の表示

あるノードから複数の分岐が出ている場合、`[3]` のようなマーカーが表示され、何本に分岐しているかがわかる。

### 折り畳み

▼/▶アイコンをクリックするとサブツリーを折り畳み/展開できる（Notionのトグルと同じ操作感）。折り畳み状態は会話ごとにブラウザに保存され、リロードしても維持される。

### カスタムラベル

ノードをダブルクリックすると、テキスト入力欄が開き、任意のラベルを保存できる。デフォルトはメッセージ冒頭約40文字のプレビューだが、「比較A」「採用版」「ボツ」など自分でわかるメモに上書きできる。ラベルはブラウザに永続保存される。

### ノードジャンプ

ツリー内のアクティブなノードをクリックすると、対応するメッセージまでスクロールし、一瞬ハイライトされる。長い会話での目的箇所への移動が格段に速くなる。

### キーボードショートカット

**Alt + B** でパネルの表示/非表示を切り替える。スクリプト冒頭の `SHORTCUT` オブジェクトを編集すると任意のキーに変更できる。

```javascript
const SHORTCUT = {
  key:   'b',     // 押すキー
  alt:   true,    // Altキーを組み合わせるか
  ctrl:  false,   // Ctrlキーを組み合わせるか
  shift: false,   // Shiftキーを組み合わせるか
};
```

### 自動更新

メッセージ送信・応答受信・ブランチ切り替え時にツリーが自動で更新される。MutationObserver（即時検知）とバックグラウンドポーリング（フォールバック）を併用。

### ドラッグ & リサイズ

ヘッダーをドラッグしてパネルを移動できる。4辺・4角からリサイズ可能。位置とサイズはブラウザに保存され、次回訪問時に復元される。

### ダーク / ライトモード対応

Claude.aiのテーマに自動で追従する。

## インストール

1. ブラウザに **[Tampermonkey](https://www.tampermonkey.net/)** を導入する（Chrome, Firefox, Edge 等）
2. **[ここをクリックしてスクリプトをインストール](https://raw.githubusercontent.com/Sc5N6A9L/claude-branch-tree-viewer/main/branch-tree-viewer.user.js)**
3. Tampermonkeyのダイアログで **「インストール」** をクリック
4. [claude.ai](https://claude.ai) を開くと、ツールバーにブランチアイコン（⎇）が追加される

> **[Greasy Fork](https://greasyfork.org/en/scripts/571332-claude-branch-tree-viewer)** でも公開しています

## 使い方

1. [claude.ai](https://claude.ai) の任意の会話を開く
2. ツールバーの **ブランチアイコン** をクリック（または **Alt + B**）
3. ツリーパネルが開き、会話の分岐構造が表示される
4. **シングルクリック** → そのメッセージまでスクロール
5. **ダブルクリック** → ラベルを編集
6. **▼ をクリック** → サブツリーの折り畳み/展開
7. **ヘッダーをドラッグ** → パネルを移動
8. **辺・角をドラッグ** → パネルをリサイズ

## 動作環境

| | 対応状況 |
|---|---|
| **ブラウザ** | Chrome, Firefox, Edge（Tampermonkey対応ブラウザ全般） |
| **スクリプトマネージャ** | Tampermonkey, Violentmonkey, Greasemonkey |
| **動作確認** | Claude.ai（2026年3月時点） |

> **注意:** Claude.aiの内部DOMやAPI構造はアップデートで変わる可能性がある。

## 仕組み

Claude.aiの内部API（`/api/organizations/.../chat_conversations/...?tree=True`）を呼び出し、全ブランチを含む完全なメッセージツリーを取得する。ユーザー発言のみを抽出して階層構造を構築し、フローティングパネルにレンダリングする。アクティブブランチはAPIレスポンスの `current_leaf_message_uuid` から特定される。

外部サーバーへのデータ送信は一切なし。すべてブラウザ内でローカルに動作する。

## 既知の制限事項

- **ブランチ切り替えボタン:** Claude.aiの◀▶ボタンでブランチを切り替えた場合、ツリーの更新に最大約1.5秒かかることがある（ポーリング間隔）。多くの場合はMutationObserverで即時検知される。
- **非常に大きな会話:** 数百のブランチがある会話ではレンダリングに若干の遅延が生じる可能性がある。
- **DOM構造の変更:** Anthropic側のフロントエンド更新により、ツールバーボタンの挿入やメッセージ検出が壊れることがある。コアのツリーロジック（API利用）はより耐性がある。

## ライセンス

[MIT](LICENSE)
