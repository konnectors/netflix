process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://397c3282a3bd46b39eaf5e91770fe362:6f81483e6c1e4760a3a69a937fecf147@sentry.cozycloud.cc/44'

const {
  BaseKonnector,
  requestFactory,
  saveBills,
  // updateOrCreate,
  scrape,
  signin,
  errors
} = require('cozy-konnector-libs')
const log = require('cozy-logger')
const pdf = require('pdfjs')
const { URL } = require('url')
const html2pdf = require('./html2pdf')
const moment = require('moment')

const baseUrl = 'https://www.netflix.com'
const NBSPACE = '\xa0'
const DEBUG = false

module.exports = new BaseKonnector(start)

async function start(fields) {
  const $ = await authenticate(fields)

  await selectProfile($, fields)

  // we need the build number to make API calls
  const buildNumber = await getBuildNumber($)

  await Promise.all([
    fetchBills(fields, buildNumber)
    // fetchViews(fields, buildNumber),
    // fetchOpinions(fields, buildNumber)
  ])
}

async function authenticate(fields) {
  log.info('authenticating...')
  // follow some redirects to get correct cookie & login urls
  const loginURL = await getLoginURLAndCookies()

  return signin({
    url: loginURL,
    debug: DEBUG,
    formSelector: 'form.login-form',
    formData: {
      email: fields.login,
      userLoginId: fields.login,
      password: fields.password
    },
    validate: (status, $) => {
      log.info('validating, status=' + status)
      log.info('validating, items=' + $('.list-profiles').length)

      if ($.html().includes('<b>Incorrect password.</b>')) {
        return false
      } else if ($.html().includes('We are having technical difficulties')) {
        throw new Error(errors.VENDOR_DOWN)
      }

      return status == 200 && $('.list-profiles').length == 1
    },
    headers: {
      'Accept-Language': 'en-US'
    },
    followRedirect: true
  })
}

async function getLoginURLAndCookies() {
  const request = requestFactory({
    debug: DEBUG,
    cheerio: true,
    jar: true
  })
  // follow some redirects to get correct cookie & login urls
  const resp = await request({
    url: `${baseUrl}/login`,
    debug: DEBUG,
    resolveWithFullResponse: true
  })

  return resp.request.uri.href
}

async function selectProfile($, fields) {
  // get login link for first profile
  let profileSelectHref = $('.profile-link').attr('href')
  if (fields.profileName) {
    const isRequestedProfileName = e =>
      $(e)
        .find('.profile-name')
        .text() === fields.profileName

    const correctLink = $('.profile-link').filter(isRequestedProfileName)
    if (correctLink.length > 0) profileSelectHref = correctLink.attr('href')
  }
  if (!profileSelectHref) throw new Error('VENDOR_DOWN')
  const request = requestFactory({
    debug: DEBUG,
    cheerio: true,
    jar: true
  })
  await request(baseUrl + profileSelectHref) // click link to set cookie
}

async function fetchBills(fields) {
  const request = requestFactory({
    debug: DEBUG,
    cheerio: true,
    jar: true
  })
  const $bills = await request(baseUrl + '/BillingActivity')
  moment.locale($bills('.accountLayout').attr('lang') || 'fr')
  const bills = scrape(
    $bills,
    {
      fileurl: {
        sel: '.billDate a',
        attr: 'href'
      },
      date: {
        sel: '.billDate',
        parse: text => moment(text, 'L')
      },
      amount: '.billTotal'
    },
    '.billingSectionSpace .retableRow'
  )
  for (let bill of bills) {
    const [amount, currency] = bill.amount.split(NBSPACE)
    bill.amount = parseFloat(amount.replace(',', '.'))
    bill.vendor = 'Netflix'
    bill.currency = currency
    bill.filename = bill.date.format('YYYY-MM-DD') + '_' + amount + '.pdf'
    bill.date = bill.date.toDate()
    const url = new URL(bill.fileurl, baseUrl)
    delete bill.fileurl
    bill.filestream = await billURLToStream(url.toString())
  }
  await saveBills(bills, fields, {
    identifiers: ['netflix'],
    contentType: 'application/pdf'
  })
}

async function billURLToStream(url) {
  var doc = new pdf.Document()
  const cell = doc.cell({ paddingBottom: 0.5 * pdf.cm }).text()
  cell.add('Généré automatiquement par le connecteur Netflix depuis la page ', {
    font: require('pdfjs/font/Helvetica-Bold'),
    fontSize: 14
  })
  cell.add(url, {
    link: url,
    color: '0x0000FF'
  })
  const request = requestFactory({
    debug: DEBUG,
    cheerio: true,
    jar: true
  })
  const $ = await request(url)
  html2pdf($, doc, $('.invoiceContainer'), { baseURL: url })
  doc.end()
  return doc
}

// const viewsDoctype = 'io.cozy.netflix.views'
// const viewsUniqFields = ['date', 'movieID']
// async function fetchViews(fields, buildNumber) {
//   const request = requestFactory({ debug: DEBUG, jar: true })
//   let page = 0
//   let done = false

//   log('info', `start importing views`)
//   do {
//     const { viewedItems } = await request({
//       url:
//         baseUrl +
//         `/api/shakti/${buildNumber}/viewingactivity` +
//         `?pg=${page++}&pgSize=100`,
//       json: true
//     })
//     log('info', `importing ${viewedItems.length} views`)
//     await updateOrCreate(viewedItems, viewsDoctype, viewsUniqFields)
//     done = viewedItems.length == 0
//   } while (!done)
//   log('info', 'done importing views')
// }

// const evaluationsDoctype = 'io.cozy.netflix.opinions'
// const evaluationsUniqFields = ['date', 'movieID']
// async function fetchOpinions(fields, buildNumber) {
//   const request = requestFactory({ debug: DEBUG, jar: true })
//   let page = 0
//   let done = false

//   log('info', `start importing opinions`)
//   do {
//     const { ratingItems } = await request({
//       url:
//         baseUrl +
//         `/api/shakti/${buildNumber}/ratinghistory` +
//         `?pg=${page++}&pgSize=100`,
//       json: true
//     })
//     log('info', `importing ${ratingItems.length} opinions`)
//     await updateOrCreate(ratingItems, evaluationsDoctype, evaluationsUniqFields)
//     done = ratingItems.length == 0
//   } while (!done)
//   log('info', 'done importing opinions')
// }

// buildNumber is necessary for api requests
async function getBuildNumber($) {
  let result = ''
  const buildMarker = '"BUILD_IDENTIFIER":"'
  $('script').each((i, el) => {
    const txtNode = el.children[0]
    let start = txtNode && txtNode.data.indexOf(buildMarker)
    if (start > 0) {
      start = start + buildMarker.length
      const end = txtNode.data.indexOf('"', start)
      result = txtNode.data.substring(start, end)
    }
  })
  return result
}
