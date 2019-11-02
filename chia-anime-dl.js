const fs = require('fs')
const path = require('path')

const cheerio = require('cheerio')
const request = require('request-promise-native')


// constants
const PA_JS = 'http://www1.chia-anime.com/pa.js'
const ANIMEAPP_URL = 'http://download.animeapp.net/video/<VIDEO_ID>'

const COMMON_HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.92 Safari/537.36'
};

// state track
const jar = request.jar()

// regexes
const PT_NON_ALPHA_NUM = /[^\w\d]+/g
const PT_INLINE_FUNC_EXEC = /\(\s*function\s*\(.*?\)\s*\{.*?\}\s*\(.*?\)\);?/s
const PT_SCRIPT2_EVAL_URL = /href="(.*?)"/
const PT_ANIMEPRIME_URL_VIDEO_ID = /animepremium.\w{2,4}\/video\/([\w\d\-]+)/


// utility methods
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
  let request = require('request')

  let headers = COMMON_HTTP_HEADERS
  headers['Referer'] = ANIMEAPP_URL.replace('<VIDEO_ID>', videoID)

  return new Promise((resolve, reject) => {
    request
      .get({ url, headers, jar })
      .pipe(fs.createWriteStream(destFilePath))
      .on('finish', resolve)
      .on('error', reject)
  })
}


// wrapper methods
async function downloadSeries (seriesName, seriesURL, destDir) {
  if (!destDir) {
    destDir = normalizeFileName(seriesName)
  }
  fs.mkdirSync(destDir, { recursive: true })

  console.info(`Series: ${seriesName}`)
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
  await downloadVideo(videoURL, destFilePath, videoID)
}


// main
(async () => {
  await downloadSeries(
    'Hunter x Hunter',
    'http://www.chia-anime.me/episode/hunter-x-hunter-2011/'
  )
})()
