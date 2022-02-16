process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://397c3282a3bd46b39eaf5e91770fe362:6f81483e6c1e4760a3a69a937fecf147@sentry.cozycloud.cc/44'

const {
  CookieKonnector,
  scrape,
  errors,
  solveCaptcha
} = require('cozy-konnector-libs')
const log = require('cozy-logger')
const pdf = require('pdfjs')
const { URL } = require('url')
const html2pdf = require('./html2pdf')
const moment = require('moment')

const baseUrl = 'https://www.netflix.com'
const NBSPACE = '\xa0'
const DEBUG = false

class NetflixConnector extends CookieKonnector {
  async fetch(fields) {
    const $ = (await this.testSession()) || (await this.authenticate(fields))

    await this.selectProfile($, fields)

    // we need the build number to make API calls
    const buildNumber = await getBuildNumber($)

    await Promise.all([
      this.fetchBills(fields, buildNumber)
      // fetchViews(fields, buildNumber),
      // fetchOpinions(fields, buildNumber)
    ])
  }

  async testSession() {
    log('info', 'testing the session...')
    if (!this._jar._jar.toJSON().cookies.length) {
      return false
    }
    const $ = await this.request(`${baseUrl}/ProfilesGate`)
    const profileSelectHref = $('.profile-link').attr('href')

    if (profileSelectHref) {
      log('info', 'session is still valid')
      return $
    } else {
      log('info', 'session test failed')
      await this.resetSession()
      return false
    }
  }

  async authenticate(fields) {
    // follow some redirects to get correct cookie & login urls
    const { url: loginURL, websiteKey } = await this.getLoginURLAndCookies()

    let recaptchaResponseToken
    if (websiteKey) {
      recaptchaResponseToken = await solveCaptcha({
        websiteURL: loginURL,
        websiteKey
      })
    }

    const $ = await this.signin({
      url: loginURL,
      debug: DEBUG,
      formSelector: 'form.login-form',
      formData: {
        userLoginId: fields.login,
        password: fields.password,
        rememberMe: 'true',
        recaptchaResponseToken
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

    return $
  }

  async getLoginURLAndCookies() {
    // follow some redirects to get correct cookie & login urls
    const resp = await this.request({
      url: `${baseUrl}/login`,
      debug: DEBUG,
      resolveWithFullResponse: true
    })

    const websiteKey = resp.body
      .html()
      .split('recaptchaSitekey')[1]
      .match(/"value":"(.*)"},"countryIsoCode"/)[1]

    return { url: resp.request.uri.href, websiteKey }
  }

  async selectProfile($, fields) {
    // get login link for first profile
    let profileSelectHref = $('.profile-link').attr('href')
    if (fields.profileName) {
      const isRequestedProfileName = e =>
        $(e).find('.profile-name').text() === fields.profileName

      const correctLink = $('.profile-link').filter(isRequestedProfileName)
      if (correctLink.length > 0) profileSelectHref = correctLink.attr('href')
    }

    if (!profileSelectHref) throw new Error('VENDOR_DOWN')
    await this.request(baseUrl + profileSelectHref) // click link to set cookie
  }

  async fetchBills(fields) {
    const $bills = await this.request(baseUrl + '/BillingActivity')
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
        amount: '.billTotal',
        vendorRef: {
          sel: '.billDate a',
          attr: 'href',
          parse: a => a.split('/').pop()
        }
      },
      '.billingSectionSpace .retableRow'
    )
    for (let bill of bills) {
      const [amount, currency] = bill.amount.split(NBSPACE)
      bill.amount = parseFloat(amount.replace(',', '.'))
      bill.vendor = 'Netflix'
      bill.currency = currency
      bill.filename = mybill =>
        moment(mybill.date).format('YYYY-MM-DD') + '_' + amount + '.pdf'
      bill.date = bill.date.toDate()
      bill.filestream = await this.billURLToStream(
        new URL(bill.fileurl, baseUrl).toString()
      )
      delete bill.fileurl
    }
    await this.saveBills(bills, fields, {
      identifiers: ['netflix'],
      contentType: true,
      fileIdAttributes: ['vendorRef']
    })
  }

  async billURLToStream(url) {
    var doc = new pdf.Document()
    const cell = doc.cell({ paddingBottom: 0.5 * pdf.cm }).text()
    cell.add(
      'Généré automatiquement par le connecteur Netflix depuis la page ',
      {
        font: require('pdfjs/font/Helvetica-Bold'),
        fontSize: 14
      }
    )
    cell.add(url, {
      link: url,
      color: '0x0000FF'
    })
    const $ = await this.request(url)
    html2pdf($, doc, $('.invoiceContainer'), { baseURL: url })
    doc.end()
    return doc
  }
}

const connector = new NetflixConnector({
  debug: DEBUG,
  cheerio: true,
  json: false
})
connector.run()

// const viewsDoctype = 'io.cozy.netflix.views'
// const viewsUniqFields = ['date', 'movieID']
// async function fetchViews(fields, buildNumber) {
//   const request = requestFactory({ debug: DEBUG, jar: j })
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
//   const request = requestFactory({ debug: DEBUG, jar: j })
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
