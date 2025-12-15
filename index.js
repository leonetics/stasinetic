// to avoid leaking all my stuff on git
require('dotenv').config()

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const axios = require('axios')

const WHITELIST = (process.env.WHITELIST || '')
  .split(',')
  .map(name => name.trim().toLowerCase())
  .filter(Boolean)

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL

const PEARL_ACTION_BLOCK = JSON.parse(process.env.PEARL_POS)
const IDLE_BLOCK = JSON.parse(process.env.IDLE_POS) 

const MAIN_USERNAME = process.env.MAIN_USERNAME
const MCIGN = process.env.MCIGN

// flags
let intruderFlag = false
let yumyumFlag = false
let movementFlag = false

function log(message) {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] ${message}`)
}

async function sendWebhook(message) {
  if (!WEBHOOK_URL) return

  try {
    await axios.post(WEBHOOK_URL, {
      content: message
    })
  } catch (err) {
    console.error('Failed to send webhook:', err.message || err)
  }
}

function createBot() {
  const bot = mineflayer.createBot({
    host: '2b2t.org',
    username: MCIGN,
    auth: 'microsoft',
    version: '1.19.2'
  })

  // LOAD PATHFINDER PLUGIN AS SOON AS BOT IS CREATED
  bot.loadPlugin(pathfinder)

  bindBotEvents(bot)
  return bot
}

function bindBotEvents(bot) {
  intruderFlag = false
  yumyumFlag = false
  movementFlag = false

  let defaultMove

  bot.on('spawn', () => {
    log('Bot spawned in.')
    sendWebhook(`✅ **\`${bot.username}\` logged in and spawned.**`)

    defaultMove = new Movements(bot)
    defaultMove.allow1by1towers = false // Do not build 1x1 towers when going up
    defaultMove.canDig = false // Disable breaking of blocks when pathing
    defaultMove.scafoldingBlocks.push(bot.registry.itemsByName['netherrack'].id)
    bot.pathfinder.setMovements(defaultMove)

    // walk to idle block once on spawn
    if (IDLE_BLOCK) {
      moveToIdle(bot)
    } else {
      log('IDLE_BLOCK is not defined (check IDLE_POS env var).')
    }

    // Anti-AFK: swing mainhand every 30 seconds
    setInterval(() => {
      if (!yumyumFlag) bot.swingArm('right')
    }, 30000)
  })

  bot.on('physicsTick', () => {
    if (!IDLE_BLOCK || movementFlag || yumyumFlag) return

    const idleVec = new Vec3(IDLE_BLOCK.x + 0.5, IDLE_BLOCK.y, IDLE_BLOCK.z + 0.5)
    const dist = bot.entity.position.distanceTo(idleVec)

    // if we're more than 2 blocks away from idle position, go back
    if (dist > 2) {
      moveToIdle(bot)
    }
  })

  bot.on('message', (jsonMsg) => {
    const msg = jsonMsg.toString()

    // Example formats:
    // [Player -> me] hello
    // From Player: hello
    // fuck you chatgpt
    let match =
      msg.match(/^(.+?) whispers: (.+)$/)

    if (!match) return

    const username = match[1]
    const message = match[2]

    log(`[WHISPER] <${username}> ${message}`)

    // 🔐 example: only allow MAIN_USERNAME
    if (username === MAIN_USERNAME) {
      if (message === '~stasinetic' || message === '~s') {
        triggerPearl(bot)
        sendWebhook(`🎯 **Pearlbot triggered via whisper by \`${username}\`.**`)
      }
    }
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return

    log(`<${username}> ${message}`)

        if (username === MAIN_USERNAME) {
            if (message === '~stasinetic' || message === '~s') {
                triggerPearl(bot)
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
    if (!intruderFlag) {
      log('Disconnected. Reconnecting in 10s...')
      sendWebhook('🔁 **Bot disconnected. Attempting reconnect in 10 seconds...**')

      setTimeout(() => {
        createBot()
      }, 10000)
    } else {
      log('Disconnected. Reconnecting in 30 minutes due to intruder...')
      sendWebhook('❌ **Bot disconnected due to intruder. Attempting reconnect in 30 minutes...**')
      setTimeout(() => {
        createBot()
      }, 1800000) // 30 min
    }
  })

  bot.on('death', () => {
    bot.quit()
    sendWebhook('❌ **Bot died.**')
  })

  bot.on('health', () => {
    if (bot.health <= 10) {
      if (!eatEnchantedGapple(bot)) {
        bot.quit()
      }
    }
    if (bot.food < 6) {
      if (!eatEnchantedGapple(bot)) {
        bot.quit()
      }
    }
  })
}

// skidded
async function moveToIdle(bot) {
  if (!IDLE_BLOCK) return
  if (movementFlag) return

  movementFlag = true

  const goal = new GoalNear(IDLE_BLOCK.x, IDLE_BLOCK.y, IDLE_BLOCK.z, 1)

  try {
    await bot.pathfinder.goto(goal)
    log('Reached idle block.')
  } catch (err) {
    console.log('Failed pathfinding:', err)
    sendWebhook('❌ **Bot failed pathfinding to idle block.**')
  } finally {
    movementFlag = false
  }
}


async function eatEnchantedGapple(bot) {
  // if we're already in the process of eating, do nothing
  if (yumyumFlag) return false

  yumyumFlag = true

  try {
    const gapple = bot.inventory.items().find(
      item => item.name === 'enchanted_golden_apple'
    )

    if (!gapple) {
      console.log('No enchanted golden apples found!')
      await sendWebhook('❌ **Bot ran out of food.**')
      return false
    }

    await bot.equip(gapple, 'hand')
    await bot.consume()   // this takes time, during which health event keeps firing
    await sendWebhook('🟢 **Bot hungry yum yum.**')
    return true
  } catch (err) {
    console.log('Failed to eat enchanted golden apple:', err)
    await sendWebhook('❌ **Bot failed to eat enchanted golden apple.**')
    return false
  } finally {
    yumyumFlag = false // IMPORTANT: always release the lock
  }
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


        console.log('Pearl trigger attempt done.')
    } catch (err) {
        console.log('Error while triggering pearl:', err)
        sendWebhook('❌ **Bot failed triggering pearl:**', err)
    }
}

createBot()