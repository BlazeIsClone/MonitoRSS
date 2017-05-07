const fs = require('fs')
const getArticles = require('../rss/rss.js')
const sqlCmds = require('../rss/sql/commands.js')
const sqlConnect = require('../rss/sql/connect.js')
const config = require('../config.json')
const storage = require('./storage.js')
const currentGuilds = storage.currentGuilds // Directory of guild profiles (Map)
const feedTracker = storage.feedTracker // Directory object of rssNames with their values as schedule names
const allScheduleWords = storage.allScheduleWords
const failedFeeds = storage.failedFeeds
const configChecks = require('./configCheck.js')
const debugFeeds = require('../util/debugFeeds').list
const events = require('events')
const process = require('child_process')

module.exports = function(bot, callback, schedule) {
  var timer

  this.cycle = new events.EventEmitter()
  const sourceList = new Map()
  const modSourceList = new Map()
  const batchSize = (config.advanced && config.advanced.batchSize) ? config.advanced.batchSize : 400
  const failLimit = (config.feedSettings.failLimit && !isNaN(parseInt(config.feedSettings.failLimit, 10))) ? parseInt(config.feedSettings.failLimit, 10) : 0

  let processorList = []
  let regBatchList = []
  let modBatchList = []
  let cycleInProgress = this.inProgress
  let cycle = this.cycle
  let con
  let startTime

  function addFailedFeed(link, rssList) {
    failedFeeds[link] = (failedFeeds[link]) ? failedFeeds[link] + 1 : 1

    console.log(failedFeeds[link])

    if (failedFeeds[link] > failLimit) {
      console.log(`RSS Error: ${link} has passed the fail limit (${failLimit}). Will no longer retrieve.`);
      if (config.feedSettings.notifyFail != true) return;
      for (var rssName in rssList) {
        bot.channels.get(rssList[rssName].channel).send(`**ATTENTION** - Feed link <${link}> has exceeded the connection failure limit and will not be retried until bot instance is restarted. *See ${config.botSettings.prefix}rsslist* for more information.`);
      }
    }
  }

  function exceedsFailCount(link) {
    return failedFeeds[link] && failedFeeds[link] > failLimit
  }

  function addToSourceLists(guildRss, guildId) { // rssList is an object per guildRss
    let rssList = guildRss.sources

    function delegateFeed(rssName) {

      if (rssList[rssName].advanced && rssList[rssName].advanced.size() > 0) { // Special source list for feeds with unique settings defined
        let linkList = {};
        linkList[rssName] = rssList[rssName];
        modSourceList.set(rssList[rssName].link, linkList);
      }
      else if (sourceList.has(rssList[rssName].link)) {
        let linkList = sourceList.get(rssList[rssName].link);
        linkList[rssName] = rssList[rssName];
      }
      else {
        let linkList = {};
        linkList[rssName] = rssList[rssName];
        sourceList.set(rssList[rssName].link, linkList);
      }
    }

    for (var rssName in rssList) {
      if (configChecks.checkExists(rssName, rssList[rssName], false) && configChecks.validChannel(bot, guildId, rssList[rssName]) && !exceedsFailCount(rssList[rssName].link)) {
        if (feedTracker[rssName] === schedule.name) { // If assigned to a schedule
          delegateFeed(rssName);
        }

        else if (schedule.name !== 'default' && !feedTracker[rssName]) { // If current feed schedule is a custom one and is not assigned
          let keywords = schedule.keywords;
          for (var q in keywords) {
            if (rssList[rssName].link.includes(keywords[q])) feedTracker[rssName] = schedule.name; // Assign this feed to this schedule so no other feed schedule can take it
            delegateFeed(rssName);
          }
        }

        else if (!feedTracker[rssName]) { // Has no schedule, was not previously assigned, so see if it can be assigned to default
          let reserveForOtherSched = false;
          for (var w in allScheduleWords) { // If it can't be assigned to default, it will eventually be assigned to other schedules when they occur
            if (rssList[rssName].link.includes(allScheduleWords[w])) reserveForOtherSched = true;
          }
          if (!reserveForOtherSched) {
            feedTracker[rssName] = 'default';
            delegateFeed(rssName);
          }
        }
      }
    }
  }

  function genBatchLists() { // Each batch is a bunch of links. Too many links at once will cause request failures.
    let batch = new Map()

    sourceList.forEach(function(rssList, link) { // rssList per link
      if (batch.size >= batchSize) {
        regBatchList.push(batch);
        batch = new Map();
      }
      batch.set(link, rssList)
    })

    if (batch.size > 0) regBatchList.push(batch);

    batch = new Map()

    modSourceList.forEach(function(source, link) { // One RSS source per link instead of an rssList
      if (batch.size >= batchSize) {
        modBatchList.push(batch);
        batch = new Map();
      }
      batch.set(link, source)
    })

    if (batch.size > 0) modBatchList.push(batch);
  }

  function connect() {
    if (cycleInProgress) {
      if (processorList.length === 0) {
        console.log(`RSS Info: Previous ${schedule.name === 'default' ? 'default ' : ''}feed retrieval cycle${schedule.name !== 'default' ? ' (' + schedule.name + ') ' : ''} was unable to finish, attempting to start new cycle.`);
        return endCon(true);
      }
      else {
        console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}Processors from previous cycle were not killed. Killing all processors now.`);
        for (var x in processorList) {
          processorList[x].kill();
        }
        processorList = []
      }
    }
    startTime = new Date()
    cycleInProgress = true
    regBatchList = []
    modBatchList = []

    modSourceList.clear() // Regenerate source lists on every cycle to account for changes to guilds
    sourceList.clear()
    currentGuilds.forEach(addToSourceLists)
    genBatchLists()

    if (sourceList.size + modSourceList.size === 0) {
      cycleInProgress = false;
      return console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}RSS Info: Finished ${schedule.name === 'default' ? 'default ' : ''}feed retrieval cycle${schedule.name !== 'default' ? ' (' + schedule.name + ')' : ''}. No feeds to retrieve.`);
    }

    switch(config.advanced.processorMethod) {
      case 'single':
        con = sqlConnect(function() {
          getBatch(0, regBatchList, 'regular')
        })
        break;
      case 'isolated':
        getBatchIsolated(0, regBatchList, 'regular');
        break;
      case 'parallel':
        getBatchParallel();
    }
  }


  function getBatch(batchNumber, batchList, type) {
    if (batchList.length === 0) return getBatch(0, modBatchList, 'modded');
    let completedLinks = 0
    let currentBatch = batchList[batchNumber]

    currentBatch.forEach(function(rssList, link) {
      var uniqueSettings = undefined
      for (var mod_rssName in rssList) {
        if (rssList[mod_rssName].advanced && rssList[mod_rssName].advanced.size() > 0) {
          uniqueSettings = rssList[mod_rssName].advanced;
        }
      }

      getArticles(con, link, rssList, uniqueSettings, function(linkCompletion) {

        if (linkCompletion.status === 'article') {
          if (debugFeeds.includes(linkCompletion.article.rssName)) console.log(`DEBUG ${linkCompletion.article.rssName}: Emitted article event.`);
          return cycle.emit('article', linkCompletion.article);
        }
        if (linkCompletion.status === 'failed' && failLimit !== 0) addFailedFeed(linkCompletion.link, linkCompletion.rssList);
        if (linkCompletion.status === 'success' && failedFeeds[linkCompletion.link]) delete failedFeeds[linkCompletion.link];

        completedLinks++
        if (completedLinks === currentBatch.size) {
          if (batchNumber !== batchList.length - 1) setTimeout(getBatch, 200, batchNumber + 1, batchList, type);
          else if (type === 'regular' && modBatchList.length > 0) setTimeout(getBatch, 200, 0, modBatchList, 'modded');
          else return endCon();
        }

      })
    })
  }

  function getBatchIsolated(batchNumber, batchList, type) {
    if (batchList.length === 0) return getBatchIsolated(0, modBatchList, 'modded');
    let completedLinks = 0
    let currentBatch = batchList[batchNumber]

    const processor = process.fork('./rss/rssProcessor.js')

    currentBatch.forEach(function(rssList, link) {
      var uniqueSettings = undefined
      for (var mod_rssName in rssList) {
        if (rssList[mod_rssName].advanced && rssList[mod_rssName].advanced.size() > 0) {
          uniqueSettings = rssList[mod_rssName].advanced;
        }
      }
      processor.send({link: link, rssList: rssList, uniqueSettings: uniqueSettings, debugFeeds: debugFeeds})
    })

    processor.on('message', function(linkCompletion) {
      if (linkCompletion.status === 'article') return cycle.emit('article', linkCompletion.article);
      if (linkCompletion.status === 'failed' && failLimit !== 0) addFailedFeed(linkCompletion.link, linkCompletion.rssList);
      if (linkCompletion.status === 'success' && failedFeeds[linkCompletion.link]) delete failedFeeds[linkCompletion.link];

      completedLinks++;
      if (completedLinks === currentBatch.size) {
        if (batchNumber !== batchList.length - 1) setTimeout(getBatchIsolated, 200, batchNumber + 1, batchList, type);
        else if (type === 'regular' && modBatchList.length > 0) setTimeout(getBatchIsolated, 200, 0, modBatchList, 'modded');
        else finishCycle();
        processor.kill();
      }
    })

  }

  function getBatchParallel() {
    let totalBatchLengths = regBatchList.length + modBatchList.length
    let completedBatches = 0

    function deployProcessors(batchList, index) {
      let completedLinks = 0

      processorList.push(process.fork('./rss/rssProcessor.js'));
      let currentBatch = batchList[index];

      let processorIndex = processorList.length - 1
      let processor = processorList[processorIndex]

      processor.on('message', function(linkCompletion) {
        if (linkCompletion.status === 'article') return cycle.emit('article', linkCompletion.article);
        if (linkCompletion.status === 'failed' && failLimit !== 0) addFailedFeed(linkCompletion.link, linkCompletion.rssList);
        if (linkCompletion.status === 'success' && failedFeeds[linkCompletion.link]) delete failedFeeds[linkCompletion.link];

        completedLinks++;
        if (completedLinks === currentBatch.size) {
          completedBatches++;
          processor.kill();
          processorList.splice(processorIndex, 1);
          if (completedBatches === totalBatchLengths) finishCycle();
        }
      })

      currentBatch.forEach(function(rssList, link) {
        var uniqueSettings = undefined
        for (var mod_rssName in rssList) {
          if (rssList[mod_rssName].advanced && rssList[mod_rssName].advanced.size() > 0) {
            uniqueSettings = rssList[mod_rssName].advanced;
          }
        }
        processor.send({link: link, rssList: rssList, uniqueSettings: uniqueSettings, debugFeeds: debugFeeds})
      })
    }

    for (var i in regBatchList) {deployProcessors(regBatchList, i)}
    for (var y in modBatchList) {deployProcessors(modBatchList, y)}
  }


  function endCon(startingCycle) {
    sqlCmds.end(con, function(err) { // End SQL connection
      if (err) console.log('Error: Could not close SQL connection. ' + err)
      cycleInProgress = false
      if (startingCycle) return connect();
      finishCycle();
    }, startingCycle);
  }

  function finishCycle() {
    if (processorList.length === 0) cycleInProgress = false;
    var timeTaken = ((new Date() - startTime) / 1000).toFixed(2)
    console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}RSS Info: Finished ${schedule.name === 'default' ? 'default ' : ''}feed retrieval cycle${schedule.name !== 'default' ? ' (' + schedule.name + ') ' : ''}. Cycle Time: ${timeTaken}s`);
  }


  let refreshTime = schedule.refreshTimeMinutes ? schedule.refreshTimeMinutes : (config.feedSettings.refreshTimeMinutes) ? config.feedSettings.refreshTimeMinutes : 15;
  timer = setInterval(connect, refreshTime*60000)

  console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}Schedule '${schedule.name}' has begun.`)

  this.stop = function() {
    clearInterval(timer)
  }

  callback(this.cycle)
  return this
}
