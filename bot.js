const mineflayer = require('mineflayer')
const fs = require('fs')
const express = require('express')

const BOT_PASSWORD = 'MyBot12345'
let bot = null
let reconnectTimer = null

// ============ RL BRAIN ============
let Q = {}
try {
  Q = JSON.parse(fs.readFileSync('brain.json'))
  console.log('Loaded brain with ' + Object.keys(Q).length + ' memories')
} catch(e) {
  console.log('New brain - no memories yet!')
}

const ACTIONS = ['forward', 'left', 'right', 'down', 'up']
let epsilon = 0.3
let totalReward = 0
let oresMined = 0
let blocksMined = 0
let isMining = false
let miningLoop = null
let isDigging = false

const ORE_NAMES = [
  'diamond_ore', 'deepslate_diamond_ore',
  'iron_ore', 'deepslate_iron_ore',
  'gold_ore', 'deepslate_gold_ore',
  'coal_ore', 'deepslate_coal_ore',
  'emerald_ore', 'deepslate_emerald_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'copper_ore', 'deepslate_copper_ore'
]

function getState() {
  const pos = bot.entity.position
  const below = bot.blockAt(pos.offset(0, -1, 0))?.name || 'air'
  const front = bot.blockAt(pos.offset(0, 0, 1))?.name || 'air'
  const front2 = bot.blockAt(pos.offset(0, 1, 1))?.name || 'air'
  return below + '|' + front + '|' + front2
}

function chooseAction(state) {
  if (!Q[state]) Q[state] = [0, 0, 0, 0, 0]
  if (Math.random() < epsilon) {
    return Math.floor(Math.random() * ACTIONS.length)
  }
  let best = 0
  for (let i = 1; i < 5; i++) {
    if (Q[state][i] > Q[state][best]) best = i
  }
  return best
}

function getReward(name) {
  if (name === 'diamond_ore' || name === 'deepslate_diamond_ore') return 100
  if (name === 'emerald_ore' || name === 'deepslate_emerald_ore') return 80
  if (name === 'gold_ore' || name === 'deepslate_gold_ore') return 50
  if (name === 'iron_ore' || name === 'deepslate_iron_ore') return 40
  if (name === 'coal_ore' || name === 'deepslate_coal_ore') return 20
  if (name === 'lapis_ore' || name === 'redstone_ore') return 30
  if (name === 'copper_ore' || name === 'deepslate_copper_ore') return 15
  if (name === 'lava' || name === 'bedrock') return -100
  if (name === 'obsidian') return 5
  if (name === 'stone' || name === 'deepslate' || name === 'tuff') return -1
  if (name === 'gravel' || name === 'dirt' || name === 'sand') return -2
  return 0
}

function isExposed(block) {
  const dirs = [
    [1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1]
  ]
  for (const [dx, dy, dz] of dirs) {
    const neighbor = bot.blockAt(block.position.offset(dx, dy, dz))
    if (!neighbor) continue
    if (neighbor.name === 'air' || neighbor.name === 'cave_air' || neighbor.name === 'water') {
      return true
    }
  }
  return false
}

function findVisibleOre() {
  const pos = bot.entity.position
  let closest = null
  let closestDist = 999
  for (let x = -4; x <= 4; x++) {
    for (let y = -2; y <= 2; y++) {
      for (let z = -4; z <= 4; z++) {
        const block = bot.blockAt(pos.offset(x, y, z))
        if (block && ORE_NAMES.includes(block.name)) {
          if (!isExposed(block)) continue
          const dist = Math.abs(x) + Math.abs(y) + Math.abs(z)
          if (dist < closestDist) {
            closestDist = dist
            closest = block
          }
        }
      }
    }
  }
  return closest
}

async function digBlockFully(block) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const stillThere = bot.blockAt(block.position)
    if (!stillThere || stillThere.name === 'air') return true
    try {
      const bestTool = bot.inventory.items().find(i => {
        if (block.name.includes('ore') || block.name === 'stone' || block.name === 'deepslate' || block.name === 'obsidian') return i.name.includes('pickaxe')
        if (block.name === 'dirt' || block.name === 'sand' || block.name === 'gravel') return i.name.includes('shovel')
        if (block.name.includes('log') || block.name.includes('wood')) return i.name.includes('axe')
        return i.name.includes('pickaxe')
      })
      if (bestTool) {
        try { await bot.equip(bestTool, 'hand') } catch(e) {}
      }
      console.log(`Mining ${block.name} - HOLDING...`)
      await bot.dig(block, true)
      const after = bot.blockAt(block.position)
      if (!after || after.name === 'air') return true
    } catch(e) {
      console.log(`Dig interrupted for ${block.name}, retrying...`)
      await new Promise(r => setTimeout(r, 500))
    }
  }
  return false
}

async function mineStep() {
  if (!isMining || !bot.entity) return
  if (isDigging) return
  if (bot.targetDigBlock) return

  if (bot.entity.position.y < -50) {
    console.log('Too low! Going up!')
    const blockAbove = bot.blockAt(bot.entity.position.offset(0, 2, 0))
    if (blockAbove && blockAbove.name !== 'air' && blockAbove.name !== 'bedrock') {
      try { await digBlockFully(blockAbove) } catch(e) {}
    }
    bot.setControlState('jump', true)
    setTimeout(() => bot.clearControlStates(), 500)
    return
  }

  const ore = findVisibleOre()
  if (ore) {
    console.log(`VISIBLE ORE! ${ore.name} - GOING FOR IT!`)
    bot.chat(`I can see ${ore.name}! Mining it!`)
    const dist = bot.entity.position.distanceTo(ore.position)
    if (dist > 4) {
      bot.lookAt(ore.position.offset(0.5, 0.5, 0.5))
      bot.setControlState('forward', true)
      setTimeout(() => bot.clearControlStates(), 600)
      return
    }
    if (!bot.canDigBlock(ore)) {
      console.log(`Can't dig ${ore.name} - need better tool`)
      return
    }
    isDigging = true
    try {
      const success = await digBlockFully(ore)
      isDigging = false
      if (!success) return
      blocksMined++
      const reward = getReward(ore.name)
      totalReward += reward
      oresMined++
      const state = getState()
      if (!Q[state]) Q[state] = [0, 0, 0, 0, 0]
      for (let i = 0; i < 5; i++) Q[state][i] += reward * 0.1
      fs.writeFileSync('brain.json', JSON.stringify(Q))
      console.log(`FOUND ${ore.name} +${reward} | Total: ${totalReward} | Ores: ${oresMined}`)
      bot.chat(`Got ${ore.name}! Total ores: ${oresMined} - Reward: ${totalReward}`)
      return
    } catch(e) {
      isDigging = false
      return
    }
  }

  const state = getState()
  const actionIndex = chooseAction(state)
  const action = ACTIONS[actionIndex]

  let target = bot.entity.position.clone()
  if (action === 'forward') target = target.offset(0, 0, 1)
  if (action === 'left') target = target.offset(-1, 0, 0)
  if (action === 'right') target = target.offset(1, 0, 0)
  if (action === 'down') target = target.offset(0, -1, 0)
  if (action === 'up') target = target.offset(0, 2, 0)

  const block = bot.blockAt(target)
  if (!block || block.name === 'air' || block.name === 'bedrock') {
    bot.setControlState('forward', true)
    setTimeout(() => bot.clearControlStates(), 400)
    return
  }
  if (block.name === 'lava' || block.name === 'water') {
    Q[state][actionIndex] = -100
    return
  }
  if (!bot.canDigBlock(block)) return

  isDigging = true
  try {
    const success = await digBlockFully(block)
    isDigging = false
    if (!success) return
    blocksMined++
    const reward = getReward(block.name)
    totalReward += reward
    if (reward >= 20) oresMined++
    const nextState = getState()
    if (!Q[nextState]) Q[nextState] = [0, 0, 0, 0, 0]
    const maxNext = Math.max(...Q[nextState])
    Q[state][actionIndex] = Q[state][actionIndex] + 0.1 * (reward + 0.9 * maxNext - Q[state][actionIndex])
    fs.writeFileSync('brain.json', JSON.stringify(Q))
    if (reward >= 20) {
      console.log(`FOUND ${block.name} +${reward} | Total: ${totalReward} | Ores: ${oresMined}`)
      bot.chat(`Found ${block.name}! Total ores: ${oresMined}`)
    } else {
      console.log(`Mined ${block.name} | Reward ${reward} | Total ${totalReward}`)
    }
  } catch(e) {
    isDigging = false
  }
}

function startMining() {
  if (isMining) return bot.chat('Already mining!')
  isMining = true
  bot.chat('RL Miner STARTED! I only mine ores I can actually SEE!')
  console.log('MINING STARTED')
  miningLoop = setInterval(mineStep, 300)
}

function stopMining() {
  isMining = false
  if (miningLoop) clearInterval(miningLoop)
  bot.clearControlStates()
  bot.chat(`Stopped! Mined ${blocksMined} blocks, ${oresMined} ores. I remember ${Object.keys(Q).length} situations!`)
  console.log('MINING STOPPED')
}

function createBot() {
  console.log('Trying to join Ancodes.aternos.me...')
  bot = mineflayer.createBot({
    host: 'Ancodes.aternos.me',
    port: 25565,
    username: 'MyBot',
    version: '26.1',
    auth: 'offline',
    checkTimeoutInterval: 60000
  })

  bot.on('spawn', () => {
    console.log('Bot joined!')
    setTimeout(() => {
      bot.chat('/register ' + BOT_PASSWORD + ' ' + BOT_PASSWORD)
      setTimeout(() => {
        bot.chat('/login ' + BOT_PASSWORD)
      }, 1500)
    }, 2000)
  })

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().toLowerCase()
    if (text.includes('register')) {
      bot.chat('/register ' + BOT_PASSWORD + ' ' + BOT_PASSWORD)
      console.log('AuthMe asked to register - trying...')
    }
    if (text.includes('login') || text.includes('log in')) {
      bot.chat('/login ' + BOT_PASSWORD)
      console.log('AuthMe asked to login - trying...')
    }
    if (text.includes('successfully') && text.includes('logged')) {
      console.log('Bot logged in!')
      bot.chat('RL Miner ready! Say "mine" to start!')
    }
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    const msg = message.toLowerCase().trim()
    if (msg === 'mine') startMining()
    if (msg === 'stop') stopMining()
    if (msg === 'stats') {
      bot.chat(`Stats: ${blocksMined} blocks, ${oresMined} ores, Reward: ${totalReward}, Brain: ${Object.keys(Q).length} memories`)
    }
    if (msg === 'forget') {
      Q = {}
      totalReward = 0
      oresMined = 0
      blocksMined = 0
      fs.writeFileSync('brain.json', JSON.stringify(Q))
      bot.chat('Brain wiped! Starting fresh!')
    }
    if (msg === 'bye' || msg === 'disconnect' || msg === 'leave') {
      bot.chat('Bye bye! Disconnecting...')
      setTimeout(() => bot.quit(), 1000)
    }
    if (msg === 'stop script' || msg === 'stop bot') {
      bot.chat('Stopping script... Bye!')
      setTimeout(() => {
        bot.quit()
        process.exit()
      }, 1000)
    }
  })

  bot.on('kicked', (reason) => {
    console.log('KICKED: ' + reason)
  })
  bot.on('error', (err) => {
    console.log('Error: ' + err)
  })
  bot.on('end', () => {
    console.log('Bot disconnected - will try again in 5 seconds...')
    if (miningLoop) clearInterval(miningLoop)
    isMining = false
    isDigging = false
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      createBot()
    }, 5000)
  })
}

createBot()

// ============ WEBSITE FOR RENDER ============
const app = express()
const PORT = process.env.PORT || 3000

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>MyBot Dashboard</title></head>
      <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #111; color: white;">
        <h1>⛏️ MyBot is Online!</h1>
        <p>Server: Ancodes.aternos.me</p>
        <p style="color: #a7f3d0; font-size: 16px; margin-top: 5px;">Play on Minecraft 26.1.2 - Java Edition</p>
        <p>Bot Name: MyBot</p>
        <h2>Stats</h2>
        <p>Ores mined: ${oresMined}</p>
        <p>Blocks mined: ${blocksMined}</p>
        <p>Total Reward: ${totalReward}</p>
        <p>Mining right now? ${isMining ? 'YES - Mining!' : 'No - Say "mine" in game'}</p>
        <p>Brain memories: ${Object.keys(Q).length}</p>
        <br>
        <p>Say "mine" in Minecraft chat to start it!</p>
        <p style="color: #888;">Auto-refreshes every 10 seconds</p>
        <script>setTimeout(() => location.reload(), 10000)</script>
      </body>
    </html>
  `)
})

app.listen(PORT, () => console.log('Website running on ' + PORT))
