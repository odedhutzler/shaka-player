/**
 * @license
 * Copyright 2016 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

describe('HlsParser live', function() {
  const Util = shaka.test.Util;
  const ManifestParser = shaka.test.ManifestParser;
  const toUTF8 = shaka.util.StringUtils.toUTF8;

  const updateTime = 5;
  const master = [
    '#EXTM3U\n',
    '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1",',
    'RESOLUTION=960x540,FRAME-RATE=60\n',
    'test:/video\n'
  ].join('');

  /** @type {!shaka.test.FakeNetworkingEngine} */
  let fakeNetEngine;
  /** @type {!shaka.hls.HlsParser} */
  let parser;
  /** @type {shakaExtern.ManifestParser.PlayerInterface} */
  let playerInterface;
  /** @type {shakaExtern.ManifestConfiguration} */
  let config;
  /** @type {ArrayBuffer} */
  let initSegmentData;
  /** @type {ArrayBuffer} */
  let segmentData;
  /** @type {ArrayBuffer} */
  let selfInitializingSegmentData;
  /** @type {ArrayBuffer} */
  let tsSegmentData;
  /** @type {ArrayBuffer} */
  let pastRolloverSegmentData;
  /** @type {number} */
  let rolloverOffset;
  /** @type {number} */
  let segmentDataStartTime;

  beforeEach(function() {
    // TODO: use StreamGenerator?
    initSegmentData = new Uint8Array([
      0x00, 0x00, 0x00, 0x30, // size (48)
      0x6D, 0x6F, 0x6F, 0x76, // type (moov)
      0x00, 0x00, 0x00, 0x28, // trak size (40)
      0x74, 0x72, 0x61, 0x6B, // type (trak)
      0x00, 0x00, 0x00, 0x20, // mdia size (32)
      0x6D, 0x64, 0x69, 0x61, // type (mdia)

      0x00, 0x00, 0x00, 0x18, // mdhd size (24)
      0x6D, 0x64, 0x68, 0x64, // type (mdhd)
      0x00, 0x00, 0x00, 0x00, // version and flags

      0x00, 0x00, 0x00, 0x00, // creation time (0)
      0x00, 0x00, 0x00, 0x00, // modification time (0)
      0x00, 0x00, 0x03, 0xe8, // timescale (1000)
    ]).buffer;
    segmentData = new Uint8Array([
      0x00, 0x00, 0x00, 0x24, // size (36)
      0x6D, 0x6F, 0x6F, 0x66, // type (moof)
      0x00, 0x00, 0x00, 0x1C, // traf size (28)
      0x74, 0x72, 0x61, 0x66, // type (traf)
      0x00, 0x00, 0x00, 0x14, // tfdt size (20)
      0x74, 0x66, 0x64, 0x74, // type (tfdt)
      0x01, 0x00, 0x00, 0x00, // version and flags
      0x00, 0x00, 0x00, 0x00, // baseMediaDecodeTime first 4 bytes
      0x00, 0x00, 0x07, 0xd0  // baseMediaDecodeTime last 4 bytes (2000)
    ]).buffer;
    tsSegmentData = new Uint8Array([
      0x47, // TS sync byte (fixed value)
      0x41, 0x01, // not corrupt, payload follows, packet ID 257
      0x10, // not scrambled, no adaptation field, payload only, seq #0
      0x00, 0x00, 0x01, // PES start code (fixed value)
      0xe0, // stream ID (video stream 0)
      0x00, 0x00, // PES packet length (doesn't matter)
      0x80, // marker bits (fixed value), not scrambled, not priority
      0x80, // PTS only, no DTS, other flags 0 (don't matter)
      0x05, // remaining PES header length == 5 (one timestamp)
      0x21, 0x00, 0x0b, 0x7e, 0x41 // PTS = 180000, encoded into 5 bytes
    ]).buffer;
    // 180000 divided by TS timescale (90000) = segment starts at 2s.
    segmentDataStartTime = 2;

    pastRolloverSegmentData = new Uint8Array([
      0x00, 0x00, 0x00, 0x24, // size (36)
      0x6D, 0x6F, 0x6F, 0x66, // type (moof)
      0x00, 0x00, 0x00, 0x1C, // traf size (28)
      0x74, 0x72, 0x61, 0x66, // type (traf)
      0x00, 0x00, 0x00, 0x14, // tfdt size (20)
      0x74, 0x66, 0x64, 0x74, // type (tfdt)
      0x01, 0x00, 0x00, 0x00, // version and flags
      0x00, 0x00, 0x00, 0x00, // baseMediaDecodeTime first 4 bytes
      0x0b, 0x60, 0xbc, 0x28  // baseMediaDecodeTime last 4 bytes (190889000)
    ]).buffer;

    // The timestamp above would roll over twice, so this rollover offset should
    // be applied.
    rolloverOffset = (0x200000000 * 2) / 90000;

    selfInitializingSegmentData = shaka.util.Uint8ArrayUtils.concat(
      new Uint8Array(initSegmentData),
      new Uint8Array(segmentData)).buffer;

    fakeNetEngine = new shaka.test.FakeNetworkingEngine();

    let retry = shaka.net.NetworkingEngine.defaultRetryParameters();
    config = {
      retryParameters: retry,
      dash: {
        customScheme: function(node) { return null; },
        clockSyncUri: '',
        ignoreDrmInfo: false,
        xlinkFailGracefully: false,
        defaultPresentationDelay: 10
      }
    };

    playerInterface = {
      filterNewPeriod: function() {},
      filterAllPeriods: function() {},
      networkingEngine: fakeNetEngine,
      onError: fail,
      onEvent: fail,
      onTimelineRegionAdded: fail
    };

    parser = new shaka.hls.HlsParser();
    parser.configure(config);
  });

  afterEach(function() {
    // HLS parser stop is synchronous.
    parser.stop();
  });

  /**
   * Simulate time to trigger a manifest update.
   */
  function delayForUpdatePeriod() {
    // Tick the virtual clock to trigger an update and resolve all Promises.
    Util.fakeEventLoop(updateTime);
  }

  function testUpdate(done, master, initialMedia, initialReferences,
                      updatedMedia, updatedReferences) {
    fakeNetEngine.setResponseMap({
      'test:/master': toUTF8(master),
      'test:/video': toUTF8(initialMedia),
      'test:/video2': toUTF8(initialMedia),
      'test:/audio': toUTF8(initialMedia),
      'test:/init.mp4': initSegmentData,
      'test:/main.mp4': segmentData,
      'test:/selfInit.mp4': selfInitializingSegmentData,
    });
    parser.start('test:/master', playerInterface)
      .then(function(manifest) {
          let variants = manifest.periods[0].variants;
          for (let i = 0; i < variants.length; i++) {
            let video = variants[i].video;
            let audio = variants[i].audio;
            ManifestParser.verifySegmentIndex(video, initialReferences);
            if (audio)
              ManifestParser.verifySegmentIndex(audio, initialReferences);
          }

          fakeNetEngine.setResponseMapAsText({
            'test:/master': master,
            'test:/video': updatedMedia,
            'test:/video2': updatedMedia,
            'test:/audio': updatedMedia
          });

          delayForUpdatePeriod();
          for (let i = 0; i < variants.length; i++) {
            let video = variants[i].video;
            let audio = variants[i].audio;
            ManifestParser.verifySegmentIndex(video, updatedReferences);
            if (audio)
              ManifestParser.verifySegmentIndex(audio, updatedReferences);
          }
        }).catch(fail).then(done);
    PromiseMock.flush();
  }


  describe('playlist type EVENT', function() {
    const media = [
      '#EXTM3U\n',
      '#EXT-X-PLAYLIST-TYPE:EVENT\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="test:/init.mp4",BYTERANGE="616@0"\n',
      '#EXTINF:2,\n',
      'test:/main.mp4\n'
    ].join('');

    const mediaWithAdditionalSegment = [
      '#EXTM3U\n',
      '#EXT-X-PLAYLIST-TYPE:EVENT\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="test:/init.mp4",BYTERANGE="616@0"\n',
      '#EXTINF:2,\n',
      'test:/main.mp4\n',
      '#EXTINF:2,\n',
      'test:/main2.mp4\n'
    ].join('');

    it('treats already ended presentation like VOD', function(done) {
      fakeNetEngine.setResponseMap({
        'test:/master': toUTF8(master),
        'test:/video': toUTF8(media + '#EXT-X-ENDLIST'),
        'test:/init.mp4': initSegmentData,
        'test:/main.mp4': segmentData
      });

      parser.start('test:/master', playerInterface)
        .then(function(manifest) {
            expect(manifest.presentationTimeline.isLive()).toBe(false);
            expect(manifest.presentationTimeline.isInProgress()).toBe(false);
          })
        .catch(fail)
        .then(done);
    });

    describe('update', function() {
      beforeAll(function() {
        jasmine.clock().install();
        // This mock is required for fakeEventLoop.
        PromiseMock.install();
      });

      afterAll(function() {
        jasmine.clock().uninstall();
        PromiseMock.uninstall();
      });

      it('adds new segments when they appear', function(done) {
        let ref1 = ManifestParser.makeReference('test:/main.mp4',
                                                0, 2, 4);
        let ref2 = ManifestParser.makeReference('test:/main2.mp4',
                                                1, 4, 6);

        testUpdate(done, master, media, [ref1],
                   mediaWithAdditionalSegment, [ref1, ref2]);
      });

      it('updates all variants', function(done) {
        const secondVariant = [
          '#EXT-X-STREAM-INF:BANDWIDTH=300,CODECS="avc1",',
          'RESOLUTION=1200x940,FRAME-RATE=60\n',
          'test:/video2'
        ].join('');

        let masterWithTwoVariants = master + secondVariant;
        let ref1 = ManifestParser.makeReference('test:/main.mp4',
                                                0, 2, 4);
        let ref2 = ManifestParser.makeReference('test:/main2.mp4',
                                                1, 4, 6);

        testUpdate(done, masterWithTwoVariants, media, [ref1],
                   mediaWithAdditionalSegment, [ref1, ref2]);
      });

      it('updates all streams', function(done) {
        const audio = [
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",LANGUAGE="eng",',
          'URI="test:/audio"\n'
        ].join('');

        let masterWithAudio = master + audio;
        let ref1 = ManifestParser.makeReference('test:/main.mp4',
                                                0, 2, 4);
        let ref2 = ManifestParser.makeReference('test:/main2.mp4',
                                                1, 4, 6);

        testUpdate(done, masterWithAudio, media, [ref1],
                   mediaWithAdditionalSegment, [ref1, ref2]);
      });

      it('handles multiple updates', function(done) {
        const newSegment1 = [
          '#EXTINF:2,\n',
          'test:/main2.mp4\n'
        ].join('');

        const newSegment2 = [
          '#EXTINF:2,\n',
          'test:/main3.mp4\n'
        ].join('');

        let updatedMedia1 = media + newSegment1;
        let updatedMedia2 = updatedMedia1 + newSegment2;
        let ref1 = ManifestParser.makeReference('test:/main.mp4',
                                                0, 2, 4);
        let ref2 = ManifestParser.makeReference('test:/main2.mp4',
                                                1, 4, 6);
        let ref3 = ManifestParser.makeReference('test:/main3.mp4',
                                                2, 6, 8);

        fakeNetEngine.setResponseMap({
          'test:/master': toUTF8(master),
          'test:/video': toUTF8(media),
          'test:/init.mp4': initSegmentData,
          'test:/main.mp4': segmentData
        });
        parser.start('test:/master', playerInterface)
          .then(function(manifest) {
              let video = manifest.periods[0].variants[0].video;
              ManifestParser.verifySegmentIndex(video, [ref1]);

              fakeNetEngine.setResponseMapAsText({
                'test:/master': master,
                'test:/video': updatedMedia1
              });

              delayForUpdatePeriod();
              ManifestParser.verifySegmentIndex(video, [ref1, ref2]);

              fakeNetEngine.setResponseMapAsText({
                'test:/master': master,
                'test:/video': updatedMedia2
              });

              delayForUpdatePeriod();
              ManifestParser.verifySegmentIndex(video, [ref1, ref2, ref3]);
            }).catch(fail).then(done);
        PromiseMock.flush();
      });

      it('converts presentation to VOD when it is finished', function(done) {
        fakeNetEngine.setResponseMap({
          'test:/master': toUTF8(master),
          'test:/video': toUTF8(media),
          'test:/init.mp4': initSegmentData,
          'test:/main.mp4': segmentData
        });

        parser.start('test:/master', playerInterface).then(function(manifest) {
          expect(manifest.presentationTimeline.isLive()).toBe(true);
          fakeNetEngine.setResponseMapAsText({
            'test:/master': master,
            'test:/video': mediaWithAdditionalSegment + '#EXT-X-ENDLIST\n'
          });

          delayForUpdatePeriod();
          expect(manifest.presentationTimeline.isLive()).toBe(false);
        }).catch(fail).then(done);
        PromiseMock.flush();
      });

      it('starts presentation as VOD when ENDLIST is present', function(done) {
        fakeNetEngine.setResponseMap({
          'test:/master': toUTF8(master),
          'test:/video': toUTF8(media + '#EXT-X-ENDLIST'),
          'test:/init.mp4': initSegmentData,
          'test:/main.mp4': segmentData
        });

        parser.start('test:/master', playerInterface).then(function(manifest) {
          expect(manifest.presentationTimeline.isLive()).toBe(false);
        }).catch(fail).then(done);
        PromiseMock.flush();
      });
    });  // describe('update')
  });  // describe('playlist type EVENT')

  describe('playlist type LIVE', function() {
    const media = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="test:/init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:2,\n',
      'test:/main.mp4\n'
    ].join('');

    const mediaWithoutSequenceNumber = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="test:/init.mp4",BYTERANGE="616@0"\n',
      '#EXTINF:2,\n',
      'test:/main.mp4\n'
    ].join('');

    const mediaWithByteRange = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="test:/init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXT-X-BYTERANGE:121090@616\n',
      '#EXTINF:2,\n',
      'test:/main.mp4\n'
    ].join('');

    const expectedStartByte = 616;
    const expectedEndByte = 121705;

    const mediaWithAdditionalSegment = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="test:/init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:2,\n',
      'test:/main.mp4\n',
      '#EXTINF:2,\n',
      'test:/main2.mp4\n'
    ].join('');

    const mediaWithRemovedSegment = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="test:/init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:1\n',
      '#EXTINF:2,\n',
      'test:/main2.mp4\n'
    ].join('');

    it('starts presentation as VOD when ENDLIST is present', function(done) {
      fakeNetEngine.setResponseMap({
        'test:/master': toUTF8(master),
        'test:/video': toUTF8(media + '#EXT-X-ENDLIST'),
        'test:/init.mp4': initSegmentData,
        'test:/main.mp4': segmentData
      });

      parser.start('test:/master', playerInterface).then(function(manifest) {
        expect(manifest.presentationTimeline.isLive()).toBe(false);
      }).catch(fail).then(done);
    });

    it('does not fail on a missing sequence number', function(done) {
      fakeNetEngine.setResponseMap({
        'test:/master': toUTF8(master),
        'test:/video': toUTF8(mediaWithoutSequenceNumber),
        'test:/init.mp4': initSegmentData,
        'test:/main.mp4': segmentData
      });

      parser.start('test:/master', playerInterface).catch(fail).then(done);
    });

    it('offsets VTT text with rolled over TS timestamps', function(done) {
      const masterWithVtt = [
        '#EXTM3U\n',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="fra",URI="test:/text"\n',
        '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1",',
        'RESOLUTION=960x540,FRAME-RATE=60\n',
        'test:/video\n',
      ].join('');

      const textPlaylist = [
        '#EXTM3U\n',
        '#EXT-X-TARGETDURATION:5\n',
        '#EXT-X-MEDIA-SEQUENCE:0\n',
        '#EXTINF:2,\n',
        'test:/main.vtt\n',
      ].join('');

      const vtt = [
        'WEBVTT\n',
        '\n',
        '00:00.000 --> 00:01.000\n',
        'Hello, world!\n',
      ].join('');

      fakeNetEngine.setResponseMap({
        'test:/master': toUTF8(masterWithVtt),
        'test:/video': toUTF8(media),
        'test:/text': toUTF8(textPlaylist),
        'test:/init.mp4': initSegmentData,
        'test:/main.mp4': pastRolloverSegmentData,
        'test:/main.vtt': toUTF8(vtt),
      });

      parser.start('test:/master', playerInterface).then(function(manifest) {
        let textStream = manifest.periods[0].textStreams[0];
        let ref = textStream.getSegmentReference(0);
        expect(ref).not.toBe(null);
        expect(ref.startTime).not.toBeLessThan(rolloverOffset);

        let videoStream = manifest.periods[0].variants[0].video;
        ref = videoStream.getSegmentReference(0);
        expect(ref).not.toBe(null);
        expect(ref.startTime).not.toBeLessThan(rolloverOffset);
      }).catch(fail).then(done);
    });

    describe('update', function() {
      beforeAll(function() {
        jasmine.clock().install();
        // This mock is required for fakeEventLoop.
        PromiseMock.install();
      });

      afterAll(function() {
        jasmine.clock().uninstall();
        PromiseMock.uninstall();
      });

      it('adds new segments when they appear', function(done) {
        let ref1 = ManifestParser.makeReference('test:/main.mp4',
                                                0, 2, 4);
        let ref2 = ManifestParser.makeReference('test:/main2.mp4',
                                                1, 4, 6);

        testUpdate(done, master, media, [ref1],
                   mediaWithAdditionalSegment, [ref1, ref2]);
      });

      it('evicts removed segments', function(done) {
        let ref1 = ManifestParser.makeReference('test:/main.mp4',
                                                0, 2, 4);
        let ref2 = ManifestParser.makeReference('test:/main2.mp4',
                                                1, 4, 6);

        testUpdate(done, master, mediaWithAdditionalSegment, [ref1, ref2],
                   mediaWithRemovedSegment, [ref2]);
      });

      it('handles updates with redirects', function(done) {
        let ref1 = ManifestParser.makeReference('test:/main.mp4',
                                                0, 2, 4);
        let ref2 = ManifestParser.makeReference('test:/main2.mp4',
                                                1, 4, 6);

        fakeNetEngine.setResponseFilter(function(type, response) {
          // Simulate a redirect by changing the response URI
          if (response.uri.indexOf('test:/redirected/') == 0) return;
          response.uri = response.uri.replace('test:/', 'test:/redirected/');
        });

        testUpdate(done, master, media, [ref1],
                   mediaWithAdditionalSegment, [ref1, ref2]);
      });

      it('parses start time from mp4 segments', function(done) {
        fakeNetEngine.setResponseMap({
          'test:/master': toUTF8(master),
          'test:/video': toUTF8(media),
          'test:/init.mp4': initSegmentData,
          'test:/main.mp4': segmentData
        });

        let ref = ManifestParser.makeReference(
            'test:/main.mp4', 0, segmentDataStartTime,
            segmentDataStartTime + 2);

        parser.start('test:/master', playerInterface).then(function(manifest) {
          let video = manifest.periods[0].variants[0].video;
          ManifestParser.verifySegmentIndex(video, [ref]);

          // In live content, we do not set presentationTimeOffset.
          expect(video.presentationTimeOffset).toEqual(0);
        }).catch(fail).then(done);
        PromiseMock.flush();
      });

      it('gets start time on update without segment request', function(done) {
        fakeNetEngine.setResponseMap({
          'test:/master': toUTF8(master),
          'test:/video': toUTF8(mediaWithAdditionalSegment),
          'test:/init.mp4': initSegmentData,
          'test:/main.mp4': segmentData
        });

        let ref1 = ManifestParser.makeReference(
            'test:/main.mp4', 0, segmentDataStartTime,
            segmentDataStartTime + 2);

        let ref2 = ManifestParser.makeReference(
            'test:/main2.mp4', 1, segmentDataStartTime + 2,
            segmentDataStartTime + 4);

        parser.start('test:/master', playerInterface).then(function(manifest) {
          let video = manifest.periods[0].variants[0].video;
          ManifestParser.verifySegmentIndex(video, [ref1, ref2]);

          fakeNetEngine.setResponseMap({
            'test:/master': toUTF8(master),
            'test:/video': toUTF8(mediaWithRemovedSegment),
            'test:/init.mp4': initSegmentData,
            'test:/main.mp4': segmentData,
            'test:/main2.mp4': segmentData
          });

          fakeNetEngine.request.calls.reset();
          delayForUpdatePeriod();

          ManifestParser.verifySegmentIndex(video, [ref2]);

          // Only one request was made, and it was for the playlist.
          // No segment requests were needed to get the start time.
          expect(fakeNetEngine.request.calls.count()).toBe(1);
          fakeNetEngine.expectRequest(
              'test:/video',
              shaka.net.NetworkingEngine.RequestType.MANIFEST);
        }).catch(fail).then(done);

        PromiseMock.flush();
      });

      it('parses start time from ts segments', function(done) {
        let tsMediaPlaylist = mediaWithRemovedSegment.replace(/\.mp4/g, '.ts');

        fakeNetEngine.setResponseMap({
          'test:/master': toUTF8(master),
          'test:/video': toUTF8(tsMediaPlaylist),
          'test:/main2.ts': tsSegmentData
        });

        let ref = ManifestParser.makeReference(
            'test:/main2.ts', 1, segmentDataStartTime,
            segmentDataStartTime + 2);

        parser.start('test:/master', playerInterface).then(function(manifest) {
          let video = manifest.periods[0].variants[0].video;
          ManifestParser.verifySegmentIndex(video, [ref]);
          // In live content, we do not set presentationTimeOffset.
          expect(video.presentationTimeOffset).toEqual(0);
        }).catch(fail).then(done);

        PromiseMock.flush();
      });

      it('gets start time of segments with byte range', function(done) {
        // Nit: this value is an implementation detail of the fix for #1106
        let partialEndByte = expectedStartByte + 2048 - 1;

        fakeNetEngine.setResponseMap({
          'test:/master': toUTF8(master),
          'test:/video': toUTF8(mediaWithByteRange),
          'test:/init.mp4': initSegmentData,
          'test:/main.mp4': segmentData
        });

        let ref = ManifestParser.makeReference(
            'test:/main.mp4' /* uri */,
            0 /* position */,
            segmentDataStartTime /* start */,
            segmentDataStartTime + 2 /* end */,
            '' /* baseUri */,
            expectedStartByte,
            expectedEndByte);  // Complete segment reference

        parser.start('test:/master', playerInterface).then(function(manifest) {
          let video = manifest.periods[0].variants[0].video;
          ManifestParser.verifySegmentIndex(video, [ref]);

          // There should have been a range request for this segment to get the
          // start time.
          fakeNetEngine.expectRangeRequest(
              'test:/main.mp4',
              expectedStartByte,
              partialEndByte);  // Partial segment request
        }).catch(fail).then(done);

        PromiseMock.flush();
      });

      it('handles rollover on update', function(done) {
        const masterWithVtt = [
          '#EXTM3U\n',
          '#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="fra",URI="test:/text"\n',
          '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1",',
          'RESOLUTION=960x540,FRAME-RATE=60\n',
          'test:/video\n',
        ].join('');

       const textPlaylist1 = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MEDIA-SEQUENCE:0\n',
          '#EXTINF:2,\n',
          'test:/main1.vtt\n',
        ].join('');

        const textPlaylist2 = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MEDIA-SEQUENCE:0\n',
          '#EXTINF:2,\n',
          'test:/main1.vtt\n',
          '#EXTINF:2,\n',
          'test:/main2.vtt\n',
        ].join('');

        // ~0.7s from rollover
        const vtt1 = [
          'WEBVTT\n',
          'X-TIMESTAMP-MAP=MPEGTS:8589870000,LOCAL:00:00:00.000\n',
          '\n',
          '00:00.000 --> 00:01.000\n',
          'Hello, world!\n',
        ].join('');

        // ~1.3s after rollover
        const vtt2 = [
          'WEBVTT\n',
          'X-TIMESTAMP-MAP=MPEGTS:115408,LOCAL:00:00:00.000\n',
          '\n',
          '00:00.000 --> 00:01.000\n',
          'Hello, again!\n',
        ].join('');

        fakeNetEngine.setResponseMap({
          'test:/master': toUTF8(masterWithVtt),
          'test:/video': toUTF8(media),
          'test:/text': toUTF8(textPlaylist1),
          'test:/init.mp4': initSegmentData,
          'test:/main.mp4': pastRolloverSegmentData,
          'test:/main1.vtt': toUTF8(vtt1),
        });

        let baseTime = 95443 + rolloverOffset;
        let ref1 = ManifestParser.makeReference('test:/main1.vtt',
                                                /* position */ 0,
                                                /* startTime */ baseTime,
                                                /* endTime */ baseTime + 2);
        let ref2 = ManifestParser.makeReference('test:/main2.vtt',
                                                /* position */ 1,
                                                /* startTime */ baseTime + 2,
                                                /* endTime */ baseTime + 4);

        parser.start('test:/master', playerInterface).then(function(manifest) {
          let text = manifest.periods[0].textStreams[0];
          ManifestParser.verifySegmentIndex(text, [ref1]);

          fakeNetEngine.setResponseMap({
            'test:/master': toUTF8(masterWithVtt),
            'test:/video': toUTF8(mediaWithAdditionalSegment),
            'test:/text': toUTF8(textPlaylist2),
            'test:/init.mp4': initSegmentData,
            'test:/main.mp4': pastRolloverSegmentData,
            'test:/main2.mp4': pastRolloverSegmentData,
            'test:/main1.vtt': toUTF8(vtt1),
            'test:/main2.vtt': toUTF8(vtt2),
          });

          fakeNetEngine.request.calls.reset();
          delayForUpdatePeriod();

          ManifestParser.verifySegmentIndex(text, [ref1, ref2]);
        }).catch(fail).then(done);

        PromiseMock.flush();
      });
    });  // describe('update')
  });  // describe('playlist type LIVE')
});  // describe('HlsParser live')
