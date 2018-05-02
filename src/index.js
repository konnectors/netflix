const {
  BaseKonnector,
  requestFactory,
  saveFiles,
  addData
} = require('cozy-konnector-libs')
const request = requestFactory({ cheerio: true })

const baseUrl = 'http://netflix.com'

module.exports = new BaseKonnector(start)

function start({email, password}) {

}
