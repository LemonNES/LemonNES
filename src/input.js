// input.js
// NES Dual Controller Input Handling with Keyboard + Gamepad + Configurable Mapping

class Controller {
    constructor(keyMap = {}, gamepadMap = {}, gamepadIndex = null) {
        this.buttons = {
            A: 0,
            B: 0,
            Select: 0,
            Start: 0,
            Up: 0,
            Down: 0,
            Left: 0,
            Right: 0
        };

        this.strobe = 0;
        this.shiftRegister = 0;

        this.keyMap = keyMap;           // Keyboard mapping
        this.gamepadMap = gamepadMap;   // Gamepad mapping
        this.gamepadIndex = gamepadIndex; // Which gamepad to use
    }

    write(value) {
        this.strobe = value & 1;
        if (this.strobe) {
            this.reload();
        }
    }

    read() {
        let value = 0;
        if (this.strobe) {
            value = this.buttons.A ? 1 : 0;
        } else {
            value = this.shiftRegister & 1;
            this.shiftRegister >>= 1;
        }
        return value | 0x40;
    }

    reload() {
        this.shiftRegister =
            (this.buttons.A     ? 1 : 0) |
            (this.buttons.B     ? 1 : 0) << 1 |
            (this.buttons.Select? 1 : 0) << 2 |
            (this.buttons.Start ? 1 : 0) << 3 |
            (this.buttons.Up    ? 1 : 0) << 4 |
            (this.buttons.Down  ? 1 : 0) << 5 |
            (this.buttons.Left  ? 1 : 0) << 6 |
            (this.buttons.Right ? 1 : 0) << 7;
    }

    setButton(name, pressed) {
        if (this.buttons.hasOwnProperty(name)) {
            this.buttons[name] = pressed ? 1 : 0;
            if (this.strobe) {
                this.reload();
            }
        }
    }

    // Poll gamepad state
    updateFromGamepad() {
        if (this.gamepadIndex === null) return;
        const gp = navigator.getGamepads()[this.gamepadIndex];
        if (!gp) return;

        for (const [btnName, mapping] of Object.entries(this.gamepadMap)) {
            if (typeof mapping === "number") {
                // Standard button index
                this.setButton(btnName, gp.buttons[mapping]?.pressed || false);
            } else if (Array.isArray(mapping)) {
                // Axis mapping: [axisIndex, direction]
                const [axis, dir] = mapping;
                if (dir === "neg") {
                    this.setButton(btnName, gp.axes[axis] < -0.5);
                } else if (dir === "pos") {
                    this.setButton(btnName, gp.axes[axis] > 0.5);
                }
            }
        }
    }

    // Update mappings
    setKeyMapping(newMap) {
        this.keyMap = { ...newMap };
    }

    setGamepadMapping(newMap) {
        this.gamepadMap = { ...newMap };
    }
}

export default class Input {
    constructor() {
        // Default mappings
        this.player1 = new Controller(
            {
                "KeyZ": "A",
                "KeyX": "B",
                "Enter": "Start",
                "ShiftLeft": "Select",
                "ArrowUp": "Up",
                "ArrowDown": "Down",
                "ArrowLeft": "Left",
                "ArrowRight": "Right"
            },
            {
                A: 0, B: 1,
                Select: 8, Start: 9,
                Up: [1, "neg"], Down: [1, "pos"],
                Left: [0, "neg"], Right: [0, "pos"]
            },
            0
        );

        this.player2 = new Controller(
            {
                "Numpad1": "A",
                "Numpad2": "B",
                "NumpadEnter": "Start",
                "Numpad0": "Select",
                "Numpad8": "Up",
                "Numpad5": "Down",
                "Numpad4": "Left",
                "Numpad6": "Right"
            },
            {
                A: 0, B: 1,
                Select: 8, Start: 9,
                Up: [1, "neg"], Down: [1, "pos"],
                Left: [0, "neg"], Right: [0, "pos"]
            },
            1
        );

        this.setupKeyboard();

        window.addEventListener("gamepadconnected", (e) => {
            console.log(`Gamepad ${e.gamepad.index} connected: ${e.gamepad.id}`);
        });
        window.addEventListener("gamepaddisconnected", (e) => {
            console.log(`Gamepad ${e.gamepad.index} disconnected`);
        });
    }

    write(addr, value) {
        if (addr === 0x4016) {
            this.player1.write(value);
            this.player2.write(value);
        }
    }

    read(addr) {
        if (addr === 0x4016) {
            return this.player1.read();
        } else if (addr === 0x4017) {
            return this.player2.read();
        }
        return 0;
    }

    setupKeyboard() {
        window.addEventListener("keydown", (e) => {
            this.handleKey(e.code, true);
        });
        window.addEventListener("keyup", (e) => {
            this.handleKey(e.code, false);
        });
    }

    handleKey(code, pressed) {
        if (this.player1.keyMap[code]) {
            this.player1.setButton(this.player1.keyMap[code], pressed);
        }
        if (this.player2.keyMap[code]) {
            this.player2.setButton(this.player2.keyMap[code], pressed);
        }
    }

    update() {
        this.player1.updateFromGamepad();
        this.player2.updateFromGamepad();
    }

    // Expose remap methods for a settings menu
    remapPlayerKey(player, newMap) {
        if (player === 1) this.player1.setKeyMapping(newMap);
        else if (player === 2) this.player2.setKeyMapping(newMap);
    }

    remapPlayerGamepad(player, newMap) {
        if (player === 1) this.player1.setGamepadMapping(newMap);
        else if (player === 2) this.player2.setGamepadMapping(newMap);
    }
}
