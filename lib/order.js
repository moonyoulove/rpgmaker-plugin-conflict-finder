function getOrder(conflicts) {
    const order = {};
    for (const { ignore, edits: [edit1, edit2] } of conflicts) {
        if (!ignore) {
            order[edit1.fileName] ??= { ahead: new Set(), behind: new Set() };
            order[edit1.fileName].ahead.add(edit2.fileName);
            order[edit2.fileName] ??= { ahead: new Set(), behind: new Set() };
            order[edit2.fileName].behind.add(edit1.fileName);
        }
    }
    for (const file in order) {
        const aheads = new Set();
        find(order[file].ahead);
        order[file].numsAhead = aheads.size;
        order[file].allAheads = [...aheads];

        function find(ahead) {
            for (const file of ahead) {
                if (!aheads.has(file)) {
                    aheads.add(file);
                    find(order[file].ahead);
                }
            }
        }
    }
    const result = Object.entries(order).sort(([, { numsAhead: a }], [, { numsAhead: b }]) => a - b).map(([file]) => file);

    const merged = [];
    for (let i = result.length - 1; i >= 0; i--) {
        const file = result[i];
        const curr = merged[0];
        if (curr && !curr.some(file2 => order[file].behind.has(file2))) {
            curr.push(file);
        } else {
            merged.unshift([file]);
        }
    }

    return merged;
}

function validate() {
    for (let i = 0; i < result.length; i++) {
        const file = result[i];
        const ahead = result.slice(0, i);
        const behind = result.slice(i + 1);
        if (ahead.some(file2 => order[file].behind.has(file2))
            || behind.some(file2 => order[file].ahead.has(file2)))
        {
            console.log(file);
        }
    }
}

export { getOrder, validate };
