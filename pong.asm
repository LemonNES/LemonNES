; pong.asm
; Minimal two-player Pong for NROM (mapper 0)
; Assemble with nesasm (asm6) or a compatible assembler.

; iNES header: 1 x 16KB PRG, 1 x 8KB CHR
.inesprg 1
.ineschr 1
.inesmap 0

; PRG origin
.org $8000

; ----------------- START/RESET -----------------
RESET:
    sei
    cld
    ldx #$40
    txs

    ; disable APU frame IRQ (safety)
    lda #$40
    sta $4017

    ; turn off PPU while init
    lda #$00
    sta $2000
    lda #$00
    sta $2001

    jsr WaitVBlank
    jsr WaitVBlank

    jsr LoadPal
    jsr ClearNameTables

    ; initialize variables (zero page)
    lda #$40 : sta P1Y
    lda #$40 : sta P2Y
    lda #$80 : sta BALLX
    lda #$70 : sta BALLY
    lda #$02 : sta BALLVX
    lda #$01 : sta BALLVY
    lda #$00 : sta SCORE1
    lda #$00 : sta SCORE2
    lda #$00 : sta NMIFLAG
    lda #$00 : sta STATE    ; 0 = serve, 1 = play, 2 = gameover
    lda #$01 : sta SERVE_PLAYER ; 1 = P1 serves, 2 = P2 serves

    jsr BuildOAM

    ; enable NMI and rendering
    lda #$80
    sta $2000
    lda #$1E
    sta $2001

MainLoop:
    ; wait for NMI flag set by NMI routine
    lda NMIFLAG
    beq MainLoop
    lda #$00 : sta NMIFLAG

    jsr ReadInputs

    ; Start button resets match (Controller1 Start -> input1 bit 3)
    lda INPUT1
    and #$08
    beq NoReset
    lda #$00 : sta SCORE1
    lda #$00 : sta SCORE2
    lda #$00 : sta STATE
    lda #$01 : sta SERVE_PLAYER
NoReset:

    lda STATE
    cmp #$00
    beq DoServe
    cmp #$01
    beq DoPlay
    jmp DoGameOver

; ---------- SERVE ----------
DoServe:
    ; if serve pressed by serve player -> set state = play
    lda SERVE_PLAYER
    cmp #$01
    beq CheckP1Serve
    ; serve player 2
    lda INPUT2
    and #$01      ; we map A/Up into bit0 in ReadInputs for convenience
    beq MainLoop
    lda #$01 : sta STATE
    jmp MainLoop

CheckP1Serve:
    lda INPUT1
    and #$01
    beq MainLoop
    lda #$01 : sta STATE
    jmp MainLoop

; ---------- PLAY ----------
DoPlay:
    ; update paddles
    ; P1 up (INPUT1 bit 1), down (bit 2)
    lda INPUT1
    and #$02
    beq P1NoUp
    lda P1Y
    sec
    sbc #$02
    sta P1Y
P1NoUp:
    lda INPUT1
    and #$04
    beq P1NoDown
    lda P1Y
    clc
    adc #$02
    sta P1Y
P1NoDown:

    ; P2 up / down
    lda INPUT2
    and #$02
    beq P2NoUp
    lda P2Y
    sec
    sbc #$02
    sta P2Y
P2NoUp:
    lda INPUT2
    and #$04
    beq P2NoDown
    lda P2Y
    clc
    adc #$02
    sta P2Y
P2NoDown:

    ; clamp paddles 16..200
    lda P1Y
    cmp #$10
    bpl P1ok1
    lda #$10 : sta P1Y
P1ok1:
    lda P1Y
    cmp #$C8    ; 200
    bcc P1ok2
    lda #$C8 : sta P1Y
P1ok2:
    lda P2Y
    cmp #$10
    bpl P2ok1
    lda #$10 : sta P2Y
P2ok1:
    lda P2Y
    cmp #$C8
    bcc P2ok2
    lda #$C8 : sta P2Y
P2ok2:

    ; move ball
    lda BALLX
    clc
    adc BALLVX
    sta BALLX
    lda BALLY
    clc
    adc BALLVY
    sta BALLY

    ; bounce top (Y < 20) or bottom (Y > 200)
    lda BALLY
    cmp #$14    ; 20
    bcc BallTop
    lda BALLY
    cmp #$C8    ; 200
    bcc BallNoVert
    ; bottom: invert VY (two's complement)
    lda BALLVY
    eor #$FF
    clc
    adc #$01
    sta BALLVY
    lda #$C8 : sta BALLY
    jmp BallNoVert
BallTop:
    ; invert VY
    lda BALLVY
    eor #$FF
    clc
    adc #$01
    sta BALLVY
    lda #$14 : sta BALLY
BallNoVert:

    ; Left paddle collision (ball X <= 28)
    lda BALLX
    cmp #$1C    ; 28
    bcs CheckRight
    ; check vertical overlap: if BALLY >= P1Y and BALLY <= P1Y+31
    lda BALLY
    cmp P1Y
    bcc NoLeftHit
    lda BALLY
    sec
    sbc P1Y
    cmp #$1F   ; 31
    bcs NoLeftHit
    ; hit: set BALLVX = +2, small VY tweak
    lda #$02 : sta BALLVX
    lda BALLY
    sec
    sbc P1Y
    cmp #$10
    bcc LeftVYNeg
    lda #$01 : sta BALLVY
    jmp LeftHitDone
LeftVYNeg:
    lda #$FF : sta BALLVY ; -1
LeftHitDone:
    jsr PlayHit
NoLeftHit:

CheckRight:
    ; Right paddle collision (ball X >= 232)
    lda BALLX
    cmp #$E8    ; 232
    bcc AfterPaddle
    lda BALLY
    cmp P2Y
    bcc NoRightHit
    lda BALLY
    sec
    sbc P2Y
    cmp #$1F
    bcs NoRightHit
    ; hit: set BALLVX = -2
    lda #$FE : sta BALLVX
    lda BALLY
    sec
    sbc P2Y
    cmp #$10
    bcc RightVYNeg
    lda #$01 : sta BALLVY
    jmp RightHitDone
RightVYNeg:
    lda #$FF : sta BALLVY
RightHitDone:
    jsr PlayHit
NoRightHit:

AfterPaddle:
    ; Score checks: left out (BALLX < 8) -> score2++, right out (BALLX > 248) -> score1++
    lda BALLX
    cmp #$08
    bcc LeftOut
    lda BALLX
    cmp #$F8    ; 248
    bcs NotRightOut
    ; right out
    inc SCORE1
    jsr PlayScore
    jsr ResetAfterScore
    jmp AfterScore
LeftOut:
    inc SCORE2
    jsr PlayScore
    jsr ResetAfterScore
AfterScore:

    jsr UpdateOAM
    jsr DrawScores

    ; check wins (>= 7)
    lda SCORE1
    cmp #$07
    bcc CheckScore2
    ; p1 wins
    lda #$02 : sta STATE
    lda #$01 : sta SERVE_PLAYER ; mark winner
    jsr PlayVictory
    jmp MainLoop
CheckScore2:
    lda SCORE2
    cmp #$07
    bcc ContinuePlay
    lda #$02 : sta STATE
    lda #$02 : sta SERVE_PLAYER
    jsr PlayVictory
    jmp MainLoop
ContinuePlay:
    jmp MainLoop

; ---------- GAMEOVER ----------
DoGameOver:
    jsr DrawGameOver
GameOverSpin:
    jsr ReadInputs
    lda INPUT1
    and #$08
    beq GameOverSpin
    ; reset
    lda #$00 : sta SCORE1
    lda #$00 : sta SCORE2
    lda #$00 : sta STATE
    lda #$01 : sta SERVE_PLAYER
    jmp MainLoop

; ---------------- SUBROUTINES ----------------

; Wait for VBlank (poll $2002 bit7)
WaitVBlank:
    lda $2002
    bpl WaitVBlank
    rts

; Simple palette loader (write to $3F00)
LoadPal:
    lda #$3F : sta $2006
    lda #$00 : sta $2006
    ; write 8 bytes (BG and sprite palettes)
    lda #$0F : sta $2007
    lda #$00 : sta $2007
    lda #$11 : sta $2007
    lda #$21 : sta $2007
    lda #$0F : sta $2007
    lda #$16 : sta $2007
    lda #$26 : sta $2007
    lda #$36 : sta $2007
    rts

; Clear small portion of name table (top area)
ClearNameTables:
    lda #$20 : sta $2006
    lda #$00 : sta $2006
    ldx #$20
ClearNTLoop:
    lda #$00 : sta $2007
    dex
    bne ClearNTLoop
    rts

; Read controllers: map to INPUT1 and INPUT2 bytes
; INPUT1 bits:
;  bit0 = serve (A/Up)
;  bit1 = up
;  bit2 = down
;  bit3 = start
ReadInputs:
    ; strobe
    lda #$01 : sta $4016
    lda #$00 : sta $4016

    ; read p1: we read sequentially, mapping bits
    lda #$00 : sta INPUT1
    ; bit0 - A
    lda $4016 : and #$01 : beq R1skipA
    lda INPUT1 : ora #$01 : sta INPUT1
R1skipA:
    lda $4016 ; read next (B) - ignore
    lda $4016 ; read next (Select) - ignore
    lda $4016 ; read (Start)
    and #$08
    beq R1skipStart
    lda INPUT1 : ora #$08 : sta INPUT1
R1skipStart:
    lda $4016 ; read (Up)
    and #$10
    beq R1skipUp
    lda INPUT1 : ora #$02 : sta INPUT1
R1skipUp:
    lda $4016 ; read (Down)
    and #$20
    beq R1skipDown
    lda INPUT1 : ora #$04 : sta INPUT1
R1skipDown:
    lda $4016 ; read rest
    lda $4016

    ; player2 via $4017
    lda #$00 : sta INPUT2
    lda $4017 : and #$01 : beq R2skipA
    lda INPUT2 : ora #$01 : sta INPUT2
R2skipA:
    lda $4017
    lda $4017
    lda $4017 : and #$08
    beq R2skipStart
    lda INPUT2 : ora #$08 : sta INPUT2
R2skipStart:
    lda $4017 : and #$10
    beq R2skipUp
    lda INPUT2 : ora #$02 : sta INPUT2
R2skipUp:
    lda $4017 : and #$20
    beq R2skipDown
    lda INPUT2 : ora #$04 : sta INPUT2
R2skipDown:
    lda $4017
    lda $4017
    rts

; Build (clear) OAM RAM area $0200..$02FF
BuildOAM:
    ldx #$00
BuildOAMLoop:
    lda #$00
    sta $0200,x
    inx
    bne BuildOAMLoop
    rts

; Update OAM with paddles and ball
UpdateOAM:
    ; left paddle top at $0200
    lda P1Y : sta $0200
    lda #$00 : sta $0201 ; tile 0
    lda #$00 : sta $0202 ; attr
    lda #$10 : sta $0203 ; X = 16

    ; left paddle bottom
    lda P1Y : clc : adc #$08 : sta $0204
    lda #$01 : sta $0205
    lda #$00 : sta $0206
    lda #$10 : sta $0207

    ; right paddle top at $0208
    lda P2Y : sta $0208
    lda #$00 : sta $0209
    lda #$00 : sta $020A
    lda #$F0 : sta $020B ; X ~ 240

    ; right paddle bottom
    lda P2Y : clc : adc #$08 : sta $020C
    lda #$01 : sta $020D
    lda #$00 : sta $020E
    lda #$F0 : sta $020F

    ; ball at $0210
    lda BALLY : sta $0210
    lda #$02 : sta $0211 ; ball tile
    lda #$00 : sta $0212
    lda BALLX : sta $0213
    rts

; Draw scores to top-center (nametable positions)
DrawScores:
    lda #$20 : sta $2006
    lda #$04 : sta $2006 ; offset
    lda SCORE1 : sta $2007
    lda #$00 : sta $2007
    lda SCORE2 : sta $2007
    rts

; Reset and go to serve after a score
ResetAfterScore:
    lda #$80 : sta BALLX
    lda #$70 : sta BALLY
    lda #$02 : sta BALLVX
    lda #$01 : sta BALLVY
    lda #$00 : sta STATE
    rts

; small sounds via APU register writes
PlayHit:
    ; simple square tone on pulse #1
    lda #$30 : sta $4000
    lda #$08 : sta $4001
    lda #$20 : sta $4002
    lda #$10 : sta $4003
    rts

PlayScore:
    lda #$70 : sta $4000
    lda #$08 : sta $4001
    lda #$40 : sta $4002
    lda #$30 : sta $4003
    rts

PlayVictory:
    jsr PlayScore
    jsr ShortDelay
    jsr PlayHit
    jsr ShortDelay
    jsr PlayScore
    rts

ShortDelay:
    ldx #$FF
DelayLoop:
    dex : bne DelayLoop
    rts

; Draw "GAME" or "SERVE" text (very simple)
DrawGameOver:
    lda #$20 : sta $2006
    lda #$60 : sta $2006
    lda #$28 : sta $2007
    lda #$29 : sta $2007
    lda #$2A : sta $2007
    rts

; --------------- NMI / IRQ ---------------
NMI:
    ; write $2005 twice to set reset scrolling (no scroll)
    lda #$00 : sta $2005
    lda #$00 : sta $2005
    ; OAM DMA from $02
    lda #$02 : sta $4014
    ; set flag for main loop
    lda #$01 : sta NMIFLAG
    rti

IRQ:
    rti

; ----------------- VECTORS -----------------
.org $FFFA
    .word NMI
    .word RESET
    .word IRQ

; ----------------- Zero page vars -----------------
.org $0000
NMIFLAG: .res 1
P1Y:     .res 1
P2Y:     .res 1
BALLX:   .res 1
BALLY:   .res 1
BALLVX:  .res 1
BALLVY:  .res 1
INPUT1:  .res 1
INPUT2:  .res 1
SCORE1:  .res 1
SCORE2:  .res 1
STATE:   .res 1
SERVE_PLAYER:.res 1

; pad until end of PRG bank
.org $C000
; (PRG bank padding if needed)
