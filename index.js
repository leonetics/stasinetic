// to avoid leaking all my stuff on git
require('dotenv').config();

const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const axios = require('axios')

function log(message) {
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] ${message}`)
}

async function sendWebhook(message) {
    if (!WEBHOOK_URL) return

    try {
        await axios.post(WEBHOOK_URL, {
            content: message
            // you can add username/avatar overrides etc here if you want
        })
    } catch (err) {
        console.error('Failed to send webhook:', err.message || err)
    }
}

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL
const PEARL_ACTION_BLOCK = JSON.parse(process.env.PEARL_POS)
const MAIN_USERNAME = process.env.MAIN_USERNAME
const MCIGN = process.env.MCIGN


function createBot() {
    const bot = mineflayer.createBot({
        host: '2b2t.org',
        username: MCIGN,
        auth: 'microsoft',
        version: '1.19.2'
    })

    bindBotEvents(bot)
    return bot
}

function bindBotEvents(bot) {
    bot.on('spawn', () => {
        log('Bot spawned in.')
        sendWebhook(`✅ **\`${bot.username}\` logged into \`${bot._client.host}\` and spawned.**`)

        // Anti-AFK: swing mainhand every 30 seconds
        setInterval(() => {
            bot.swingArm('right')
        }, 30000)
    })

    let inQueue = false
    let onMain = false

    bot.on('message', (jsonMsg) => {
        const msg = jsonMsg.toString()
        // 2b2t sends a message like this when you actually get moved:
        if (msg.includes('Connected to the server')) {
            inQueue = false
            onMain = true
            console.log('Now on main 2b2t server.')
            sendWebhook('🟢 Now on main 2b2t.')
        }
    })

    bot.on('chat', (username, message) => {
        if (username === bot.username) return

        log(`<${username}> ${message}`)

        if (username === MAIN_USERNAME) {
            if (message === '~stasinetic' || message === '~s') {
                triggerPearl(bot)
                whisperMessage(bot, MAIN_USERNAME, "Loading pearl...")
                sendWebhook(`🎯 **Pearlbot triggered pearl action as requested by \`${MAIN_USERNAME}\`.**`)
            }
        }
    })

    bot.on('kicked', (reason) => {
        log('Kicked: ' + reason)
        sendWebhook(`⚠️ **Bot was kicked from 2b2t.** Reason: \`${reason}\``)
    })

    bot.on('error', (err) => {
        log('Error: ' + err)
        sendWebhook(`❌ **Bot encountered an error:** \`\`\`${err}\`\`\``)
    })

    bot.on('end', () => {
        log('Disconnected. Reconnecting in 10s...')
        sendWebhook('🔁 **Bot disconnected. Attempting reconnect in 10 seconds...**')

        setTimeout(() => {
            createBot()
        }, 10000)
    })
}

async function triggerPearl(bot) {
    const pos = new Vec3(
        PEARL_ACTION_BLOCK.x + 0.5,
        PEARL_ACTION_BLOCK.y + 0.5,
        PEARL_ACTION_BLOCK.z + 0.5
    )

    try {
        console.log('Attempting to trigger pearl...')
        // look at block
        await bot.lookAt(pos, true)
        await bot.waitForTicks(2)

        // right click block
        await bot.activateBlock(bot.blockAt(pos))
        await bot.waitForTicks(2)

        // this is stupid, requires direct line of sight, gotta fix this later ^

        console.log('Pearl trigger attempt done.')
    } catch (err) {
        console.log('Error while triggering pearl:', err)
    }
}

async function whisperMessage(bot, recipient, message) {
    bot.chat(`/w ${recipient} ${message}`)
}

createBot()