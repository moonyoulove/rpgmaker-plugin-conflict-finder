import * as acorn from "acorn";
import esquery from "esquery";
import fs from "node:fs";
import pathlib from "node:path";
import vm from "node:vm";

const mvLibNames = ["rpg_core.js", "rpg_managers.js", "rpg_objects.js", "rpg_scenes.js", "rpg_sprites.js", "rpg_windows.js"];
const mzLibNames = ["rmmz_core.js", "rmmz_managers.js", "rmmz_objects.js", "rmmz_scenes.js", "rmmz_sprites.js", "rmmz_windows.js"];

function findConflict(projectPath) {
    const conflicts = [];
    const coreFiles = getCoreFiles(projectPath).map(path => getAST(path));
    const pluginFiles = getPluginFiles(projectPath).map(path => getAST(path));
    const inheritMap = findInherit(coreFiles.concat(pluginFiles));
    const { methodHistories, aliasHistories } = findHistory(pluginFiles, inheritMap);
    for (const methodEdits of Object.values(methodHistories)) {
        for (let i = 1; i < methodEdits.length; i++) {
            const { methodType, isChanged, className, methodName, numsAliased, isStatic } = methodEdits[i];
            // const methodAssignExpr = parseNode(methodEdit.raw, "AssignmentExpression");
            // patching Child -> overwrite Child or override Child (patching will lose its effect)
            if (methodType === "overwrite" || methodType === "override") {
                // If the code before and after overwrite is the same, it does not need to be regarded as a conflict,
                //   but is just filled in repeatedly to be on the safe side.
                // W1=>W2=>W3, W1=>W2 are regarded as a group. Maybe this group is the expected overwritten,
                //   but W2=>W3 is not, so look at them both together.
                if (isChanged) {
                    conflicts.push({ type: "overwrite", edits: [methodEdits[i - 1], methodEdits[i]] });
                }
                // patching Child -> edit Parent (the patched one is the old one)
                // conflicts P1->P2->W: W must be placed in front of P1 and P2,
                //   so outdated conflicts are different from overwrite conflicts. They depend on all previous patching.
                const aliases = aliasHistories[getKey(className, methodName, isStatic)]?.slice(0, numsAliased);
                if (aliases) {
                    aliases.forEach(({ subClass, historyIndex }) => {
                        const aliasEdit = methodHistories[getKey(subClass, methodName, isStatic)][historyIndex];
                        conflicts.push({ type: "outdated", edits: [aliasEdit, methodEdits[i]] });
                    });
                }
            }
        }
    }
    return conflicts;
}

function getAST(path) {
    const plugin = fs.readFileSync(path, "utf-8");
    const ast = acorn.parse(plugin, {
        ecmaVersion: "2020",
        locations: true,
    });
    addParentAndRaw(ast, plugin);
    return {
        fileName: pathlib.basename(path),
        ast,
    };
}

function getCoreFiles(projectPath) {
    const paths = [];
    const libNames = checkVersion(projectPath) === "MZ" ? mzLibNames : mvLibNames;
    for (const libName of libNames) {
        const path = pathlib.join(projectPath, "js", libName);
        paths.push(path);
    }
    return paths;
}

function getPluginFiles(projectPath) {
    const paths = [];
    const $plugins = evalPluginConfig(projectPath);
    for (const { name: pluginName, status: pluginStatus } of $plugins) {
        if (pluginStatus === true) {
            const path = pathlib.format({
                dir: pathlib.join(projectPath, "js/plugins"),
                name: pluginName,
                ext: ".js",
            });
            paths.push(path);
        }
    }
    return paths;
}

function evalPluginConfig(projectPath) {
    const pluginsScriptContent = fs.readFileSync(pathlib.join(projectPath, "js/plugins.js"), "utf-8");
    const pluginsScript = new vm.Script(pluginsScriptContent);
    const sandbox = {};
    pluginsScript.runInNewContext(sandbox);
    return sandbox["$plugins"];
}

function getKey(className, methodName, isStatic) {
    return className + (isStatic ? "." : ".prototype.") + methodName;
}

function findHistory(files, inheritMap) {
    const methodHistories = {};
    const aliasHistories = {};
    const currentMethods = {};
    for (const { ast, fileName } of files) {
        const varDeclares = esquery.query(ast, "VariableDeclaration");
        const assignExprs = esquery.query(ast, "AssignmentExpression");
        const template1 = parseNode("Foo.prototype.bar = baz", "AssignmentExpression");
        const template2 = parseNode("Foo.bar = baz", "AssignmentExpression");
        const methodAssignExprs = esquery.query(ast, "AssignmentExpression:has(:scope > FunctionExpression.right)").filter(node =>
            compare(template1, node) || compare(template2, node)
        );
        methodAssignExprs.forEach(methodAssignExpr => {
            const { className, isStatic } = getClassName(methodAssignExpr);
            if (["$", "_"].includes(className)) {
                return;
            }
            const methodName = esquery.query(methodAssignExpr, ":scope > MemberExpression.left > .property")[0].toRaw();
            const methodType = checkMethodType(methodAssignExpr, methodName, varDeclares, assignExprs);
            const methodSymbolExpr = esquery.query(methodAssignExpr, ":scope > MemberExpression.left")[0];
            const currentMethod = currentMethods[getKey(className, methodName, isStatic)] ?? {};
            const methodEdit = {
                fileName,
                methodType,
                isStatic,
                className,
                methodName,
                loc: getLocation(methodAssignExpr),
                fullName: methodSymbolExpr.toRaw(),
                methodSymbolLoc: getLocation(methodSymbolExpr),
                numsAliased: aliasHistories[getKey(className, methodName, isStatic)]?.length ?? 0,
                isChanged: !compare(currentMethod, methodAssignExpr),
            };
            currentMethods[getKey(className, methodName, isStatic)] = methodAssignExpr;
            methodHistories[getKey(className, methodName, isStatic)] ??= [];
            methodHistories[getKey(className, methodName, isStatic)].push(methodEdit);
            if (methodType === "patching") {
                const aliasClass = findRealAlias(className, methodName, isStatic, methodHistories, inheritMap);
                if (aliasClass !== className) {
                    aliasHistories[getKey(aliasClass, methodName, isStatic)] ??= [];
                    aliasHistories[getKey(aliasClass, methodName, isStatic)].push({
                        subClass: className,
                        historyIndex: methodHistories[getKey(className, methodName, isStatic)].length - 1,
                    });
                }
                methodEdit.aliasClass = aliasClass;
            }
        });
    }
    return { methodHistories, aliasHistories };
}

function findInherit(files) {
    const inheritMap = {};
    for (const { ast } of files) {
        // Foo.prototype = Object.create(Bar.prototype)
        const template1 = parseNode("Foo.prototype = Object.create(Bar.prototype)", "AssignmentExpression");
        const nodes1 = esquery.query(ast, "AssignmentExpression").filter(node => compare(template1, node));
        nodes1.forEach(node => {
            const className = esquery.query(node, ":scope > MemberExpression.left > .object")[0].toRaw();
            const superClass = esquery.query(node, ":scope > CallExpression.right > MemberExpression.arguments:first-child > .object")[0].toRaw();
            inheritMap[className] = superClass;
        });
        // class Foo extends Bar {}
        const nodes2 = esquery.query(ast, "ClassDeclaration");
        nodes2.forEach(node => {
            const className = esquery.query(node, ":scope > .id")[0].toRaw();
            const superClass = esquery.query(node, ":scope > .superClass")[0]?.toRaw();
            if (superClass) {
                inheritMap[className] = superClass;
            }
        });
        // Object.setPrototypeOf(Foo.prototype, Bar.prototype)
        const template3 = parseNode("Object.setPrototypeOf(Foo.prototype, Bar.prototype)", "CallExpression");
        const nodes3 = esquery.query(ast, "CallExpression").filter(node => compare(template3, node));
        nodes3.forEach(node => {
            const className = esquery.query(node, ":scope > MemberExpression.arguments:nth-child(1) > .object")[0].toRaw();
            const superClass = esquery.query(node, ":scope > MemberExpression.arguments:nth-child(2) > .object")[0].toRaw();
            inheritMap[className] = superClass;
        });
    }
    return inheritMap;
}

function getClassName(node) {
    const object = esquery.query(node, ":scope > MemberExpression.left > .object")[0];
    if (esquery.query(object, ":has(:scope > .property[name='prototype'])").length > 0) {
        return {
            className: esquery.query(object, ":scope > .object")[0].toRaw(),
            isStatic: false,
        };
    } else {
        return {
            className: object.toRaw(),
            isStatic: true,
        };
    }
}

function checkMethodType(assignExpr, methodName, varDeclares, assignExprs) {
    varDeclares = varDeclares.filter(varDeclare => varDeclare.start < assignExpr.start);
    assignExprs = assignExprs.filter(assignExpr => assignExpr.start > assignExpr.start);
    const callExprs = esquery.query(assignExpr, ":scope > FunctionExpression.right > .body CallExpression");
    for (const callExpr of callExprs) {
        // .call(this) or .apply(this)
        const query1 = ":has(:scope > MemberExpression.callee > Identifier.property[name=/^(call|apply)$/])";
        const callThisMethods = esquery.query(callExpr, query1);
        if (callThisMethods.length > 0) {
            // Quz.prototype.bar.call(this, baz);
            const query2 =
                `:scope > MemberExpression.callee > .object:has(Identifier.property[name='prototype']):has(:scope > Identifier.property[name='${methodName}'])`;
            const superMethods = esquery.query(callExpr, query2);
            if (superMethods.length > 0) {
                /*
                    if(something){
                        Baz.prototype.bar.call(this);
                    } else {
                        _Foo_bar.call(this);
                    }
                */
                if (callThisMethods.length - superMethods.length > 0) {
                    return "mixing";
                } else {
                    return "override";
                }
            } else {
                if (callThisMethods.some(callThisMethod => checkMixing(callThisMethod, varDeclares, assignExprs))) {
                    return "mixing";
                } else {
                    return "patching";
                }
            }
        }
    }
    return "overwrite";
}

function checkMixing(callExpr, varDeclares, assignExprs) {
    const methodNode = esquery.query(callExpr, ":scope > MemberExpression.callee > .object")[0];
    // const _Foo_bar = Foo.prototype.bar
    if (methodNode.type === "Identifier") {
        const varDeclare = varDeclares.findLast(varDeclare => {
            const ids = esquery.query(varDeclare, ":scope > VariableDeclarator > Identifier.id");
            return ids.some(id => compare(methodNode, id));
        });
        if (varDeclare) {
            const init = esquery.query(varDeclare, ":scope > VariableDeclarator > CallExpression.init")[0];
            // not just "Foo.prototype.bar" but something like "PluginManager.alias(Foo.prototype,'bar')"
            if (init) {
                return true;
            }
        }
    } // Baz.alias["Foo.prototype.bar"] = Foo.prototype.bar;
    else if (methodNode.type === "MemberExpression") {
        const assignExpr = assignExprs.findLast(assignExpr => {
            const left = esquery.query(assignExpr, ":scope > MemberExpression.left")[0];
            return compare(methodNode, left);
        });
        if (assignExpr) {
            const right = esquery.query(assignExpr, ":scope > CallExpression.right")[0];
            if (right) {
                return true;
            }
        }
    }
    return false;
}

function findRealAlias(className, methodName, isStatic, methodHistories, inheritMap) {
    if (methodHistories[getKey(className, methodName, isStatic)]?.length > 0) {
        return className;
    } else if (inheritMap[className]) {
        return findRealAlias(inheritMap[className], methodName);
    }
    return null;
}

function addParentAndRaw(ast, code) {
    walk(ast);

    function walk(node, parent = null) {
        if (node && node.type) {
            Object.defineProperties(node, {
                parent: {
                    value: parent,
                    configurable: true,
                    writable: true,
                },
                toRaw: {
                    value: toRaw,
                    configurable: true,
                    writable: true,
                },
            });
            node.loc.start.offset = node.start;
            node.loc.end.offset = node.end;
        }
        for (const key in node) {
            const value = node[key];
            if (value instanceof Object) {
                walk(value, node);
            }
        }
    }

    function toRaw() {
        return code.slice(this.start, this.end);
    }
}

function parseNode(code, query = ":scope") {
    const ast = acorn.parse(code, {
        ecmaVersion: "2020",
    });
    const node = esquery.query(ast, query)[0];
    return node;
}

function compare(node1, node2) {
    // template must be node1
    for (const key in node1) {
        const ignoreKeys = ["start", "end", "loc"];
        if (ignoreKeys.includes(key)) {
            continue;
        }
        const value1 = node1[key];
        const value2 = node2[key];
        if (value1 instanceof Object) {
            if (value1.type === "Identifier") {
                const placeholders = ["foo", "bar", "baz", "qux", "quux"];
                if (placeholders.includes(value1.name.toLowerCase())) {
                    continue;
                }
            }
            if (Array.isArray(value1)) {
                if (value1.length !== value2.length) {
                    return false;
                }
            }
            if (!compare(value1, value2)) {
                return false;
            }
        } else {
            if (value1 !== value2) {
                return false;
            }
        }
    }
    return true;
}

function getLocation(node) {
    return {
        start: {
            line: node.loc.start.line,
            column: node.loc.start.column,
            offset: node.start,
        },
        end: {
            line: node.loc.end.line,
            column: node.loc.end.column,
            offset: node.end,
        },
    };
}

function checkVersion(projectPath) {
    try {
        fs.accessSync(pathlib.join(projectPath, "js/rmmz_core.js"));
        return "MZ";
    } catch {
        return "MV";
    }
}

export { findConflict };
