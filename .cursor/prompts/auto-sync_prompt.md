I want an auto-sync feature. 
I stashed away all the previous attempts and want to start again from current code where sync is only manual.
Idea: when recording with only speakers (no headphones) I want to calculate the sync out of the self-bleeding.
We always need raw mic, so remove the microphone mode dropdown, as any noise cancellation or AEC may disrupt the detection.
The algo needs to listen to the YouTube source video but there is a CORS problem, so we need to capture/share the audio from the current tab, using navigator's getDisplayMedia function. A prompt by the browser will be needed before playing the video for the first time. Beware that it needs to result from a user gesture. Beware of the duration mismatch it may create between the played+recorded source video segment and the take, due to the modal browser's tab-share prompt.
Add an auto-sync button in the menu next to (advanced) global sync offset, to record source video without voice over and calculate the global sync based on bleeding. When global sync is calculated, it will be subtracted from all the non-zero sync offsets of existing tracks.
The auto-sync will also happen after every confirmed take, in a worker. It will update the per-track sync offset. Remember to subtract the global sync offset. BTW it means the per-track sync offset may be negative, because it is relative to the global one. Only the global sync offset must be positive.
Note that the source video may be silent, specially at the beginning, so the auto-sync algo should look/wait/expect for high-energy samples.
No auto-sync effort with Headphones. There we can use default noise reduction and echo cancellation, as we have no bleeding-based solution there.
Regarding the algo and the math, as learned from previous attempt, we need an "Iterative radix-2 complex FFT/IFFT" to use the time and frequency spaces. Also a GCC-PHAT. Not expert in the terms at all, but I hope it will give you direction. 
There may be multiple peaks of offset candidates, with various levels of prominence. If peaks are close enough (like <40ms), consider merging them into an average rather than casting them away for low prominence.
If no confidence, an error log should be printed with the values that led to low confidence.
After every auto-sync attempt, even successful, a log will show the offset and the elements of confidence.
We shall assume that the offset will not be above 1s. 
I want logs:
- when starting and finishing auto-sync
- when waiting/reaching high energy duing auto-sync 
- resulting offset + confidence numbers, both if success or fail (i.e. if confidence is too low and prefer 0 offset)

Also assume delay offset is > 0: mic can only add delay, it cannot get audio from the future :)

Not representative, but just FYI, when I play a YouTube vide on my desktop on the speakers and record a take, the good offset is usually around 300ms. I will test the result by listening and seeing if I need a manual fix via the existing UI.

I DON'T want you to look at the stashes of the previous attempts. They did not end well. I want a fresh start.

Let's go for a plan first.
