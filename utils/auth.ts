/* eslint-disable functional/no-expression-statements */
const { API_KEY } = import.meta.env

export const auth = (req: Request): boolean => {
	const key = req.headers.get('authorization')?.replace(/Bearer(\s)+/i, '')
	console.log('KEY', key)
	return key === API_KEY
}
