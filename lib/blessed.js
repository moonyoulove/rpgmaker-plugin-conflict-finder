import blessed from "blessed";
import fs from "node:fs";
import "dotenv/config";
import pathlib from "node:path";
import openEditor from "open-editor";
import { osLocaleSync } from "os-locale";
import { getOrder } from "./order.js";

class ConflictOutput {
    #focusGroup = [];
    #focusIndex = 0;
    #popupGroup = [];
    #resizeCallbacks = [];
    #locale = osLocaleSync();
    #ac = new AbortController();
    #screen = null;
    #list = null;
    #code1 = null;
    #code2 = null;
    #method1 = null;
    #method2 = null;
    #help = null;
    #keys = null;
    #side = null;
    #main = null;
    #footer = null;
    #wrapper1 = null;
    #wrapper2 = null;
    #result = null;
    #content = null;
    #conflicts;
    #projectPath;
    #themeColor;
    #textEditor;

    constructor(conflicts, projectPath, fullUnicode = true, themeColor = null, textEditor = null) {
        this.#conflicts = conflicts;
        this.#projectPath = projectPath;
        this.#themeColor = themeColor || process.env.COLOR || "cyan";
        this.#textEditor = textEditor;
        this.#createScreen(fullUnicode);
        this.#createLayout();
        this.#createComponents();
    }

    show() {
        this.#resize();
        this.#updateContent(0);
        this.#list.focus();
        this.#screen.render();
    }

    destroy() {
        this.#screen.destroy();
    }

    #createScreen(fullUnicode) {
        this.#screen = blessed.screen({
            smartCSR: true,
            fullUnicode: fullUnicode, // Lag when using large this.#list
            title: "conflict-finder",
        });
        this.#screen.on("keypress", (...args) => this.#screen.debug(args));
        this.#screen.key(["q", "C-c"], () => process.exit(0));
        this.#screen.key("left", () => {
            this.#focus(-1, true);
            this.#screen.render();
        });
        this.#screen.key("right", () => {
            this.#focus(1, true);
            this.#screen.render();
        });
        this.#screen.key("j", () => {
            const focused = this.#focusGroup[this.#focusIndex];
            const edits = this.#conflicts[this.#list.selected - 1].edits;
            if (focused == this.#code1) {
                this.#scrollTo(this.#code1, edits[0].loc.start.offset, true);
            } else if (focused === this.#code2) {
                this.#scrollTo(this.#code2, edits[1].loc.start.offset, true);
            }
            this.#screen.render();
        });
        this.#screen.key("i", () => {
            if (this.#focusGroup[this.#focusIndex].focused) {
                const index = this.#list.selected;
                const ignore = this.#conflicts[index - 1].ignore = !this.#conflicts[index - 1].ignore;
                this.#list.rows[index][2] = ignore ? "✓" : "";
                const scroll = this.#saveScroll(this.#list);
                this.#list.setRows(this.#list.rows);
                this.#list.select(index);
                this.#restoreScroll(this.#list, scroll);
                if (this.#focusIndex !== 0) {
                    this.#focus(0);
                }
                this.#screen.render();
            }
        });
        this.#screen.key("o", () => {
            if (this.#focusGroup[this.#focusIndex].focused) {
                const files = this.#conflicts[this.#list.selected - 1].edits.map(({ fileName, loc }) => {
                    return {
                        file: pathlib.join(this.#projectPath, "js/plugins", fileName),
                        line: loc.start.line,
                        column: loc.start.column,
                    };
                });
                this.#openInEditor(files);
            }
        });
        this.#screen.key("p", () => {
            if (this.#result.hidden) {
                const order = getOrder(this.#conflicts);
                this.#showMessage(this.#result, order.map(file => file.join("\n")).join("\n  ↓\n"));
            } else {
                this.#hideMessage(this.#result);
            }
        });
        this.#screen.key("h", () => {
            if (this.#help.hidden) {
                this.#showMessage(this.#help);
            } else {
                this.#hideMessage(this.#help);
            }
        });
    }

    #createLayout() {
        this.#footer = blessed.box({
            bottom: 0,
            width: "100%",
            height: "shrink",
        });
        this.#screen.append(this.#footer);

        this.#main = blessed.box();
        this.#screen.append(this.#main);
        this.#resizeLater(() => this.#main.height = `100%-${this.#footer.lpos.height}`);

        this.#side = blessed.box({
            width: "shrink",
            height: "100%",
        });
        this.#main.append(this.#side);

        this.#content = blessed.box({
            right: 0,
        });
        this.#main.append(this.#content);
        this.#resizeLater(() => this.#content.width = `100%-${this.#side.lpos.width}`);

        this.#wrapper1 = blessed.box({
            height: "50%",
        });
        this.#content.append(this.#wrapper1);

        this.#wrapper2 = blessed.box({
            height: "50%",
            bottom: 0,
        });
        this.#content.append(this.#wrapper2);
    }

    #createComponents() {
        this.#result = blessed.message({
            width: "60%",
            height: "60%",
            border: {
                type: "line",
            },
            top: "20%",
            left: "20%",
            hidden: true,
            scrollable: true,
            scrollbar: {
                bg: this.#themeColor,
            },
            alwaysScroll: true,
            keys: true,
            label: "Plugin Order",
            focusEffects: {
                border: {
                    fg: this.#themeColor,
                },
            },
        });
        this.#screen.append(this.#result);
        this.#popupGroup.push(this.#result);

        this.#help = blessed.message({
            content: this.#helpText(),
            width: "60%",
            height: "60%",
            border: {
                type: "line",
            },
            top: "20%",
            left: "20%",
            hidden: true,
            scrollable: true,
            scrollbar: {
                bg: this.#themeColor,
            },
            alwaysScroll: true,
            keys: true,
            label: "Help",
            focusEffects: {
                border: {
                    fg: this.#themeColor,
                },
            },
        });
        this.#screen.append(this.#help);
        this.#popupGroup.push(this.#help);

        this.#keys = blessed.text({
            tags: true,
            content: [
                `${this.#withColor("← →")} Change focus`,
                `${this.#withColor("↑ ↓")} Select or Scroll`,
                `${this.#withColor("j")} Jump back`,
                `${this.#withColor("i")} Ignore`,
                `${this.#withColor("o")} Open in Editor`,
                `${this.#withColor("p")} Plugin this.#order info`,
                `${this.#withColor("h")} Help`,
                `${this.#withColor("q")} Quit`,
            ].join(" | "),
        });
        this.#footer.append(this.#keys);

        this.#list = blessed.listtable({
            rows: this.#initList(),
            width: "shrink",
            height: "100%",
            border: {
                type: "line",
            },
            keys: true,
            style: {
                cell: {
                    selected: {
                        bg: this.#themeColor,
                        fg: "black",
                    },
                },
            },
            focusEffects: {
                border: {
                    fg: this.#themeColor,
                },
            },
            scrollbar: {
                bg: "red",
            },
        });
        this.#side.append(this.#list);
        this.#list.on("select item", (item, index) => {
            this.#updateContent(index - 1);
        });
        this.#focusGroup.push(this.#list);

        this.#method1 = blessed.text({
            tags: true,
        });
        this.#wrapper1.append(this.#method1);

        this.#code1 = blessed.box({
            top: 1,
            height: "100%-1",
            border: {
                type: "line",
            },
            scrollable: true,
            keys: true,
            alwaysScroll: true,
            scrollbar: {
                bg: this.#themeColor,
            },
            focusEffects: {
                border: {
                    fg: this.#themeColor,
                },
            },
            tags: true,
        });
        this.#wrapper1.append(this.#code1);
        this.#focusGroup.push(this.#code1);

        this.#method2 = blessed.text({
            tags: true,
        });
        this.#wrapper2.append(this.#method2);

        this.#code2 = blessed.box({
            top: 1,
            height: "100%-1",
            border: {
                type: "line",
            },
            scrollable: true,
            keys: true,
            alwaysScroll: true,
            scrollbar: {
                bg: this.#themeColor,
            },
            focusEffects: {
                border: {
                    fg: this.#themeColor,
                },
            },
            tags: true,
        });
        this.#wrapper2.append(this.#code2);
        this.#focusGroup.push(this.#code2);
    }

    #focus(index, increment = false) {
        if (this.#focusGroup[this.#focusIndex].focused) {
            this.#focusIndex = (increment ? this.#focusIndex : 0) + index;
            if (this.#focusIndex >= this.#focusGroup.length) {
                this.#focusIndex = 0;
            }
            if (this.#focusIndex < 0) {
                this.#focusIndex = this.#focusGroup.length - 1;
            }
            this.#focusGroup[this.#focusIndex].focus();
        }
    }

    #resizeLater(callback) {
        this.#resizeCallbacks.push(callback);
    }

    #resize() {
        this.#screen.render();
        this.#resizeCallbacks.forEach(callback => callback());
    }

    #updateContent(index) {
        const { edits } = this.#conflicts[index];
        this.#method1.setContent(
            `1. {bold}${edits[0].fullName}{/bold} (${edits[0].fileName}:${edits[0].loc.start.line}:${edits[0].loc.start.column})`,
        );
        this.#method1.render();
        this.#method2.setContent(
            `2. {bold}${edits[1].fullName}{/bold} (${edits[1].fileName}:${edits[1].loc.start.line}:${edits[1].loc.start.column})`,
        );
        this.#method2.render();
        this.#ac.abort();
        this.#ac = new AbortController();
        const path1 = pathlib.join(this.#projectPath, "/js/plugins/" + edits[0].fileName);
        fs.readFile(path1, { encoding: "utf-8", signal: this.#ac.signal }, (err, text1) => {
            if (!err) {
                const loc = edits[0].methodSymbolLoc;
                this.#code1.setContent(
                    text1.slice(0, loc.start.offset) + this.#withColor(text1.slice(loc.start.offset, loc.end.offset)) + text1.slice(loc.end.offset),
                );
                this.#scrollTo(this.#code1, edits[0].loc.start.offset, true);
                this.#screen.render();
            }
        });
        const path2 = pathlib.join(this.#projectPath, "/js/plugins/" + edits[1].fileName);
        fs.readFile(path2, { encoding: "utf-8", signal: this.#ac.signal }, (err, text2) => {
            if (!err) {
                const loc = edits[1].methodSymbolLoc;
                this.#code2.setContent(
                    text2.slice(0, loc.start.offset) + this.#withColor(text2.slice(loc.start.offset, loc.end.offset)) + text2.slice(loc.end.offset),
                );
                this.#scrollTo(this.#code2, edits[1].loc.start.offset, true);
                this.#screen.render();
            }
        });
    }

    #showMessage(msgBox, message = undefined) {
        this.#popupGroup.forEach(popup => popup.hide());
        this.#screen.restoreFocus();
        this.#screen.saveFocus();
        msgBox.focus();
        msgBox.scrollTo(0);
        msgBox.show();
        if (message !== undefined) {
            msgBox.setContent(message);
        }
        this.#screen.render();
    }

    #hideMessage(msgBox) {
        msgBox.hide();
        this.#screen.render();
        this.#screen.restoreFocus();
    }

    #scrollTo(scrollBox, offset, center) {
        const content = scrollBox.content;
        scrollBox.setContent(content.slice(0, offset));
        let height = scrollBox.getScrollHeight() - 1;
        if (center) {
            height -= Math.ceil((scrollBox.height - scrollBox.iheight) / 3);
        }
        scrollBox.setContent(content);
        scrollBox.setScroll(height);
    }

    #initList() {
        return [["name", "type", "i"]].concat(this.#conflicts.map((conflict, index) => {
            const { type, edits } = conflict;
            const mapping = { overwrite: "W", override: "R", patching: "P", outdated: "D", mixing: "M" };
            const edit1Type = mapping[edits[0].methodType];
            const edit2Type = mapping[edits[1].methodType];
            const conflictType = mapping[type];
            const ignore = edit1Type === "W" || edit1Type === "R";
            conflict.ignore = ignore;
            return [edits[1].fullName, `${conflictType}: ${edit1Type} → ${edit2Type}`, ignore ? "✓" : ""];
        }));
    }

    #saveScroll(scrollBox) {
        return { childBase: scrollBox.childBase, childOffset: scrollBox.childOffset };
    }

    #restoreScroll(scrollBox, { childBase, childOffset }) {
        scrollBox.childBase = childBase;
        scrollBox.childOffset = childOffset;
        this.#list.emit("scroll");
    }

    #helpText() {
        const texts = {};
        texts["zh-TW"] = `Columns
  [i]
    忽略此衝突，不在插件順序中顯示，覆寫之間(R/W → R/W)的衝突預設為省略，因為無法通過調整插件順序來解決。
  [type]
    R: Override，有調用父類的方法。
    W: Overwrite，直接替代原有方法。
    P: Patching，使用別名，在原有方法下進行修改。
    D: Outdated，使用別名，但獲取到過時的方法。
    
    有兩種衝突類別W和D，以及以下的子類別:
    P/R/W →  P : 較不容易導致衝突。
     R/W  → R/W: 導致先前的方法失去作用，但有可能是有意為之，那就不是Bug。
      P   → R/W: 如果覆寫了父類方法，則會導致別名獲取到過時的方法，不容易察覺此Bug原因。`;

        texts["zh-CN"] = `Columns
  [i]
    忽略此冲突，不在插件顺序中显示，覆写之间(R/W → R/W)的冲突预设为省略，因为无法通过调整插件顺序来解决。
  [type]
    R: Override，有调用父类的方法。
    W: Overwrite，直接替代原有方法。
    P: Patching，使用别名，在原有方法下进行修改。
    D: Outdated，使用别名，但获取到过时的方法。

    有两种冲突类别W和D，以及以下的子类别:
    P/R/W →  P : 较不容易导致冲突。
     R/W  → R/W: 导致先前的方法失去作用，但有可能是有意为之，那就不是Bug。
      P   → R/W: 如果覆写了父类方法，则会导致别名获取到过时的方法，不容易察觉此Bug原因。`;

        texts["en"] = `Columns
  [i]
    Ignore this conflict, do not display in plugin this.#order; overwrite this.#conflicts (R/W → R/W) are ignored by default, as they cannot be resolved by adjusting plugin this.#order.

  [type]
    R: Override, calls the parent class method.
    W: Overwrite, directly replaces the original method.
    P: Patching, modifies the original method using an alias.
    D: Outdated, Using alias, but getting obsolete methods.

    There are two conflict categories W and D, as well as the following subcategories:
    P/R/W →  P : Less frequent cause of this.#conflicts.
     R/W  → R/W: Causes the previous method to have no effect, but this may be on purpose and not a bug.
      P   → R/W: If the parent class method is overwritten, the alias will obtain an outdated method, making it difficult to detect the cause of this bug.`;
        return texts[this.#locale] || texts[this.#locale.split("-")[0]] || texts["en"];
    }

    #withColor(text) {
        return `{${this.#themeColor}-fg}${text}{/}`;
    }

    async #openInEditor(files) {
        for (const file of files) {
            await openEditor([file], { editor: this.#textEditor });
        }
    }
}

export { ConflictOutput };
