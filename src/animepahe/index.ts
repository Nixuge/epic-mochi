import type {
  DiscoverListing,
  DiscoverListingsRequest,
  Paging,
  Playlist,
  PlaylistDetails,
  PlaylistEpisodeServerRequest,
  PlaylistEpisodeServerResponse,
  PlaylistEpisodeSource,
  PlaylistEpisodeSourcesRequest,
  PlaylistItemsOptions,
  PlaylistItemsResponse,
  SearchFilter,
  SearchQuery,
  PlaylistEpisodeServer,
} from '@mochiapp/js/dist';
import {
  DiscoverListingOrientationType,
  DiscoverListingType,
  PlaylistEpisodeServerFormatType,
  PlaylistEpisodeServerQualityType,
  PlaylistStatus,
  PlaylistType,
  SourceModule,
  StatusError,
  VideoContent
} from '@mochiapp/js/dist';
import { PaheAiringRequest, PaheRelease } from './models/types';
import { baseUrl } from './utils/constants';
import { fetchScrapeEpisodes, paheToPlaylistItem } from './scraper/episodeScraper';
import { KwikE } from '../shared/extractors/kwik';
import { load } from 'cheerio';

// NOTE:
// unlike my other scrapers, a bunch of things here are from consumet.
// Adapted & sometimes made faster (anime's episodes requests now parallel)

export default class Source extends SourceModule implements VideoContent {
  metadata = {
    id: 'animepahe',
    name: 'AnimePahe',
    version: '0.1.18',
    icon: "https://animepahe.com/pikacon.ico"
  }

  async searchFilters(): Promise<SearchFilter[]> {
    return [];
  }
  async discoverListings(listingRequest?: DiscoverListingsRequest | undefined): Promise<DiscoverListing[]> {
    // Note: https://animepahe.ru/anime has EVERY anime listed in 1 request, could maybe use that idk.
    const url = listingRequest ? listingRequest.page : `${baseUrl}/api?m=airing&page=1`;
    const response = await request.get(url, {headers: {Referer: baseUrl}})
    if (response.status == 403) {
      throw new StatusError(403, "Blocked by DDoS-Guard.", response.text(), baseUrl);
    }

    const json: PaheAiringRequest = response.json();

    if (!json.data)
      return [];
    const items: Playlist[] = json.data.map((anime) => {
      return {
        id: anime.anime_session,
        title: anime.anime_title,
        posterImage: (anime.snapshot && anime.snapshot.length > 0) ? anime.snapshot : undefined,
        url: anime.anime_session,
        status: PlaylistStatus.unknown,
        type: PlaylistType.video
      }
    })
    return [{
      id: "latest",
      title: "Latest Releases",
      type: DiscoverListingType.featured,
      orientation: DiscoverListingOrientationType.landscape,
      paging: {
        id: url,
        // json.next_page_url = https://animepahe.ru/api?page=2
        // we need https://animepahe.ru/api?m=airing&page=2"
        previousPage: json.prev_page_url?.replace("?page=", "?m=airing&page="),
        nextPage: json.next_page_url?.replace("?page=", "?m=airing&page="),
        title: "Latest Releases",
        items
      }
    }]
  }

  async search(searchQuery: SearchQuery): Promise<Paging<Playlist>> {
    try {       
      // TODO: HANDLE MULTI PAGES SEARCH
      // EDIT: actually idk if that's supported (tried ?page=, ?p=, ?current_page=, ?currentpage= and none work)
      // Could still grab every anime in 1x before everything else but meh.
      const data: PaheRelease = await request.get(`${baseUrl}/api?m=search&q=${encodeURIComponent(searchQuery.query)}`).then(resp => resp.json());

      const res: Playlist[] = data.data.map((item: any) => ({
        id: item.session,
        title: item.title,
        posterImage: item.poster,
        url: `${item.id}/${item.session}`,
        status: PlaylistStatus.unknown, // TODO: SCRAPE THIS
        type: PlaylistType.video,
      } satisfies Playlist))

      return {
        id: "0",
        previousPage: data.prev_page_url,
        nextPage: data.next_page_url,
        items: res
      }
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  async playlistDetails(id: string): Promise<PlaylistDetails> {
    const animeInfo: PlaylistDetails = {
      altTitles: [],
      altPosters: [],
      altBanners: [],
      genres: [],
      previews: []
    } satisfies PlaylistDetails;

    try {
      const res = await request.get(
        `${baseUrl}/anime/${id}`
      );
      
      const $ = load(res.text());

      // const altPosters = $('div.anime-poster a').attr('href');
      // const altTitles = $('div.title-wrapper > h1 > span').first().text();
      // const altBanners = `https:${$('div.anime-cover').attr('data-src')}`
      // animeInfo.altTitles = (altTitles && altTitles != "") ? [altTitles] : [];
      // animeInfo.altPosters = altPosters ? [altPosters] : [];
      // animeInfo.altBanners = altBanners ? [altBanners] : [];
      animeInfo.altTitles = [$('div.title-wrapper > h1 > span').first().text()];
      animeInfo.altPosters = [$('div.anime-poster a').attr('href')!];
      animeInfo.altBanners = [`https:${$('div.anime-cover').attr('data-src')}`]; // not sure about that one

      animeInfo.synopsis = $('div.anime-summary').text();
      animeInfo.genres = $('div.anime-genre ul li')
        .map((i, el) => $(el).find('a').attr('title'))
        .get();

      return animeInfo;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  async playlistEpisodes(playlistId: string, options?: PlaylistItemsOptions | undefined): Promise<PlaylistItemsResponse> {
    // TODO: FIX THAT TO USE PAGE
    // EXPLANATION: on pahe, if page is -1 (def) scrape everything, otherwise scrape page selected
    // here (simpler): scrape everything (lol)
    

    const data = await fetchScrapeEpisodes(playlistId, 1)
    const lastPage = data.last_page;
    const episodes = [...data.data];
    if (lastPage > 1) {
      // Run all requests in parralel
      const tasks: Promise<PaheRelease>[] = []
      for (let i = 2; i <= lastPage; i++) {
        tasks.push(fetchScrapeEpisodes(playlistId, i))
      }
      for (const task of tasks) {
        episodes.push(...((await task).data))
      }
    }
    return [{
      id: "1",
      number: 1,
      variants: [{
        id: "1",
        title: "Episodes",
        pagings: [{
          id: "1",
          // previousPage?: PagingID,
          // nextPage?: PagingID,
          items: episodes.map((ep) => paheToPlaylistItem(ep))
        }]
      }]
    }]
  }

  async playlistEpisodeSources(req: PlaylistEpisodeSourcesRequest): Promise<PlaylistEpisodeSource[]> {
    try {
      const html = await request.get(`${baseUrl}/play/${req.playlistId}/${req.episodeId}`, {
        headers: {
          Referer: `${baseUrl}`,
        },
      }).then(resp => resp.text());

      const $ = load(html);

      const servers = $('div#resolutionMenu > button').map((i, el) => ({
        id: $(el).attr('data-src')!,
        displayName: $(el).text(),
        // audio: $(el).attr('data-audio'),
      } satisfies PlaylistEpisodeServer)).get();

      return [{
        id: "animepahe",
        displayName: "AnimePahe",
        servers
      }];
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  async playlistEpisodeServer(req: PlaylistEpisodeServerRequest): Promise<PlaylistEpisodeServerResponse> {
    const video = (await new KwikE(req.serverId).extract())[0];

    return {
      links: [{
        url: video.url,
        quality: PlaylistEpisodeServerQualityType.auto,
        format: PlaylistEpisodeServerFormatType.hsl
      }],
      skipTimes: [],
      headers: {},
      subtitles: [],
    }
  }
}
