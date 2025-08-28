// inputSettings.js
// NES input remapping UI with localStorage persistence + reset-to-default

import Input from "./input.js";  // your input.js

const input = new Input();
let waitingForRemap = null;

// --- Default mappings (mirror input.js) ---
const defaultMappings = {
    player1: {
        keyMap: {
            "KeyZ": "A",
            "KeyX": "B",
            "Enter": "Start",
            "ShiftLeft": "Select",
            "ArrowUp": "Up",
            "ArrowDown": "Down",
            "ArrowLeft": "Left",
            "ArrowRight": "Right"
        },
        gamepadMap: {
            A: 0, B: 1,
            Select: 8, Start: 9,
            Up: [1, "neg"], Down: [1, "pos"],
            Left: [0, "neg"], Right: [0, "pos"]
        }
    },
    player2: {
        keyMap: {
            "Numpad1": "A",
            "Numpad2": "B",
            "NumpadEnter": "Start",
            "Numpad0": "Select",
            "Numpad8": "Up",
            "Numpad5": "Down",
            "Numpad4": "Left",
            "Numpad6": "Right"
        },
        gamepadMap: {
            A: 0, B: 1,
            Select: 8, Start: 9,
            Up: [1, "neg"], Down: [1, "pos"],
            Left: [0, "neg"], Right: [0, "pos"]
        }
    }
};

// --- Load & Save ---
function loadMappings() {
    const saved = localStorage.getItem("nes-input-mappings");
    if (!saved) return;

    const data = JSON.parse(saved);

    if (data.player1) {
        input.remapPlayerKey(1, data.player1.keyMap);
        input.remapPlayerGamepad(1, data.player1.gamepadMap);
        updateUI(1, data.player1.keyMap);
    }

    if (data.player2) {
        input.remapPlayerKey(2, data.player2.keyMap);
        input.remapPlayerGamepad(2, data.player2.gamepadMap);
        updateUI(2, data.player2.keyMap);
    }
}

function saveMappings() {
    const data = {
        player1: {
            keyMap: input.player1.keyMap,
            gamepadMap: input.player1.gamepadMap
        },
        player2: {
            keyMap: input.player2.keyMap,
            gamepadMap: input.player2.gamepadMap
        }
    };
    localStorage.setItem("nes-input-mappings", JSON.stringify(data));
}

// --- Reset to default ---
function resetToDefault(player) {
    const defaults = defaultMappings[`player${player}`];

    input.remapPlayerKey(player, defaults.keyMap);
    input.remapPlayerGamepad(player, defaults.gamepadMap);

    updateUI(player, defaults.keyMap);
    saveMappings();
}

// Attach reset button listeners
document.getElementById("reset-p1").addEventListener("click", () => resetToDefault(1));
document.getElementById("reset-p2").addEventListener("click", () => resetToDefault(2));

// --- Remapping UI ---
document.querySelectorAll("button[data-player]").forEach((btn) => {
    btn.addEventListener("click", () => {
        const player = parseInt(btn.dataset.player, 10);
        const buttonName = btn.dataset.btn;
        const label = document.getElementById(`p${player}-${buttonName}`);

        waitingForRemap = { player, button: buttonName, element: label };

        btn.classList.add("waiting");
        btn.textContent = "Press key or gamepad...";
    });
});

window.addEventListener("keydown", (e) => {
    if (waitingForRemap) {
        const { player, button, element } = waitingForRemap;

        element.textContent = e.code;

        const newMap = { ...getPlayerKeyMap(player) };
        for (const key in newMap) {
            if (newMap[key] === button) delete newMap[key];
        }
        newMap[e.code] = button;

        input.remapPlayerKey(player, newMap);
        saveMappings();
        finishRemap();
    }
});

// Poll gamepads for remapping
function pollGamepads() {
    if (waitingForRemap) {
        const gpList = navigator.getGamepads();
        for (let gp of gpList) {
            if (!gp) continue;
            for (let i = 0; i < gp.buttons.length; i++) {
                if (gp.buttons[i].pressed) {
                    const { player, button, element } = waitingForRemap;
                    element.textContent = `Gamepad${gp.index}-Btn${i}`;

                    const newMap = { ...getPlayerGamepadMap(player), [button]: i };
                    input.remapPlayerGamepad(player, newMap);

                    saveMappings();
                    finishRemap();
                    return;
                }
            }
        }
    }
    requestAnimationFrame(pollGamepads);
}
pollGamepads();

function finishRemap() {
    document.querySelectorAll("button.waiting").forEach((b) => {
        b.classList.remove("waiting");
        b.textContent = "Remap";
    });
    waitingForRemap = null;
}

function getPlayerKeyMap(player) {
    return player === 1 ? input.player1.keyMap : input.player2.keyMap;
}
function getPlayerGamepadMap(player) {
    return player === 1 ? input.player1.gamepadMap : input.player2.gamepadMap;
}

function updateUI(player, keyMap) {
    for (const [key, btn] of Object.entries(keyMap)) {
        const label = document.getElementById(`p${player}-${btn}`);
        if (label) label.textContent = key;
    }
}

// Load saved mappings on start
loadMappings();// Reset both players + wipe localStorage
document.getElementById("reset-all").addEventListener("click", () => {
    resetToDefault(1);
    resetToDefault(2);
    localStorage.removeItem("nes-input-mappings");
});
