const fs = require('fs')
const path = require('path')

const yargs = require('yargs')
const cheerio = require('cheerio')
const request = require('request-promise-native')


// constants
const PA_JS = 'http://www1.chia-anime.com/pa.js'
const ANIMEAPP_URL = 'http://download.animeapp.net/video/<VIDEO_ID>'

const MAX_RETRIES = 5
const COMMON_HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.92 Safari/537.36'
};

// regexes
const PT_NON_ALPHA_NUM = /[^\w\d]+/g
const PT_SERIES_URL = /^https?:\/\/www.chia-anime.me\/episode\/(?:[^\/]+)\/$/
const PT_EPISODE_URL = /^https?:\/\/www.chia-anime.me\/(?:[^\/]+)\/$/
const PT_INLINE_FUNC_EXEC = /\(\s*function\s*\(.*?\)\s*\{.*?\}\s*\(.*?\)\);?/s
const PT_SCRIPT2_EVAL_URL = /href="(.*?)"/
const PT_ANIMEPRIME_URL_VIDEO_ID = /animepremium.\w{2,4}\/video\/([\w\d\-]+)/

// global state tracking constants & variables
const jar = request.jar()
var retries = MAX_RETRIES


// utility methods
function isSeriesURL (url) {
  return PT_SERIES_URL.test(url)
}

function isEpisodeURL (url) {
  return PT_EPISODE_URL.test(url)
}

function normalizeFileName (fileName) {
  return fileName.replace(PT_NON_ALPHA_NUM, '-')
}

async function getEpisodes (seriesURL) {
  let response = await request.get({
    url: seriesURL, jar, headers: COMMON_HTTP_HEADERS
  })
  let $ = cheerio.load(response)

  return $('#archive .post')
    .map((index, element) => ({
      name: $(element).find('h3').eq(0).text().trim(),
      url: $(element).find('a[itemprop="url"]').eq(0).attr('href')
    }))
    .get()
    .reverse()
}

async function getVideoID (episodeURL) {
  let response = await request.get({
    url: episodeURL, jar, headers: COMMON_HTTP_HEADERS
  })
  return PT_ANIMEPRIME_URL_VIDEO_ID.exec(response)[1]
}

async function getDownloadableVideoURL (videoID) {
  // make up the context
  let response = await request.get({
    url: PA_JS, jar, headers: COMMON_HTTP_HEADERS
  })
  eval(response)

  // fetch base page
  let url = ANIMEAPP_URL.replace('<VIDEO_ID>', videoID)
  response = await request.get({
    url, jar, headers: COMMON_HTTP_HEADERS
  })
  let $ = cheerio.load(response)

  // extract & evaluate script1 in the current context
  let script1 = $('body script').eq(0).html().trim()
  script1 = script1.replace(PT_INLINE_FUNC_EXEC, '').trim()
  eval(script1)

  // extract & evaluate script2 in the current context
  let script2 = $('body script').eq(1).html().trim()
  script2 = script2.replace(/^eval/, "var script2EvalResult = ")
  eval(script2)

  eval(`var finalURL = '${PT_SCRIPT2_EVAL_URL.exec(script2EvalResult)[1]}'`)
  return finalURL
}

async function downloadVideo (url, destFilePath, videoID) {
  if (fs.fileExistsSync(destFilePath)) {
    // skip
    return
  }

  let request = require('request')

  let headers = COMMON_HTTP_HEADERS
  headers['Referer'] = ANIMEAPP_URL.replace('<VIDEO_ID>', videoID)
  headers['Connection'] = 'keep-alive'

  return new Promise((resolve, reject) => {
    request
      .get({ url, headers, jar })
      .on('finish', resolve)
      .on('error', async err => {
        if (err.code === 'ECONNRESET' && --retries > 0) {
          console.error(`\t\t-- err: ${err.code} -- ${retries} retries left --`)
          try {
            await downloadVideo(url, destFilePath, videoID)
          } catch (err1) {
            reject(err)
          }
        } else {
          console.error(`\t\t[ERROR] ${err.syscall} ${err.code}`)
          reject(err)
        }
      })
      .pipe(fs.createWriteStream(destFilePath))
  })
}


// wrapper methods
async function downloadSeries (seriesURL, destDir) {
  console.info(`Series URL: ${seriesURL}`)
  console.info(`Destination Dir: ${destDir}`)

  let episodes = await getEpisodes(seriesURL)
  console.info(`Total episodes found: ${episodes.length}`)
  console.info('\nDownloading ...')

  for (let episode of episodes) {
    let fileName = `${normalizeFileName(episode.name)}.mp4`
    let destFilePath = path.join(destDir, fileName)

    console.info(`\t${episode.name}`)
    await downloadEpisode(episode.url, destFilePath)
  }
}

async function downloadEpisode (episodeURL, destFilePath) {
  let videoID = await getVideoID(episodeURL)
  let videoURL = await getDownloadableVideoURL(videoID)

  try {
    console.time('\t\tDownload Success')
    await downloadVideo(videoURL, destFilePath, videoID)
    console.timeEnd('\t\tDownload Success')
  } catch (err) {
    console.error(`\t\tDownload Failure - ${err}`)
  }
}


// main
// parse args
const args = yargs
  .scriptName('chime-anime-dl')
  .options('d', {
    alias: 'dir',
    demandOption: true,
    describe: 'Destination download directory',
    type: 'string'
  })
  .options('s', {
    alias: 'series',
    describe: 'Any chime-anime.com series URL, listing all episodes' +
      ' ex. http://www.chia-anime.me/episode/hunter-x-hunter-2011/',
    type: 'string'
  })
  .options('e', {
    alias: 'episode',
    describe: 'Any chime-anime.com episode URL' +
      ' ex. http://www.chia-anime.me/hunter-x-hunter-episode-1-english-subbed/',
    type: 'string'
  })
  .argv

// validate args
let err
if (!args.series && !args.episode) {
  err = 'Either `series` or `episode` arg is required'
} else if (args.series && !isSeriesURL(args.series)) {
  err = `Invalid Series URL - ${args.series}`
} else if (args.episode && !isEpisodeURL(args.episode)) {
  err = `Invalid Episode URL - ${args.episode}`
}
if (err) {
  console.error(`[ERROR] ${err}`)
  process.exit(1)
}

// create destination dir if it doesnt exist
fs.mkdirSync(args.dir, { recursive: true });

(async () => {
  // download
  await downloadSeries(args.series || args.episode, args.dir)
})()
